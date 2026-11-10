import "server-only";
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import type { LinkContent, LinkStatus, TagSource } from "@/lib/db/schema";
import { BadRequestError, ConflictError, HttpError, NotFoundError, TooManyRequestsError } from "@/lib/errors";
import { enqueue } from "@/lib/jobs/queue";
import { MAX_REGENERATIONS } from "@/lib/summaries/limits";
import { storedSummarySchema, type StoredSummary } from "@/lib/summaries/guardrails";
import { LIMITS } from "@/lib/limits";
import { log } from "@/lib/log";
import { ownedBy } from "@/lib/owned";
import { type Tx, advisoryLock, consumeRate } from "@/lib/usage";
import { FIXTURES, fixtureByUrl, type FixtureArticle } from "@/lib/links/fixtures";
import { normalizeUrl } from "@/lib/links/url";

const { link, linkTag, tag, job, rateEvent, linkSummary } = schema;

const TAG_NAME = /^[a-z0-9][a-z0-9-]{1,23}$/;

export const saveLinkInput = z.object({
  url: z.string().trim().min(1, "Enter an http or https URL.").max(2048),
});

export const patchLinkInput = z
  .object({
    archived: z.boolean().optional(),
    favorite: z.boolean().optional(),
    read: z.boolean().optional(),
    tags: z.array(z.string().regex(TAG_NAME, "Tags are short lowercase slugs.")).max(LIMITS.tagsPerPatch).optional(),
  })
  .refine((value) => value.archived !== undefined || value.favorite !== undefined || value.read !== undefined || value.tags !== undefined, {
    message: "Nothing to update",
  });

const listInput = z.object({
  view: z.enum(["all", "inbox", "archive", "favorites"]).default("all"),
  tag: z.string().regex(TAG_NAME).optional(),
  q: z.string().trim().max(200).optional(),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

export type TagView = { id: string; name: string; source: TagSource };

export type LinkView = {
  id: string;
  url: string;
  host: string;
  finalUrl: string | null;
  title: string | null;
  siteName: string | null;
  excerpt: string | null;
  content: { byline?: string; site?: string; paragraphs: string[] } | null;
  wordCount: number | null;
  status: LinkStatus;
  failCode: string | null;
  readAt: Date | null;
  archivedAt: Date | null;
  favorite: boolean;
  createdAt: Date;
  updatedAt: Date;
  tags: TagView[];
  /** Plain text only: render it as text, never as HTML or Markdown. Null until a summary exists. */
  summary: SummaryView | null;
};

export type SummaryView = {
  /** `live` or `demo` (recorded answer) have text; `skipped` (too little text) and `pending` (regeneration queued, none yet) don't. */
  mode: "live" | "demo" | "skipped" | "pending";
  summary: string | null;
  keyPoints: string[];
  kind: StoredSummary["kind"] | null;
  /** Show "This page may be a paywall or error page". */
  lowQuality: boolean;
  generatedAt: Date;
  /** Regenerations left for this link (of 3). */
  regenerationsLeft: number;
};

export type SaveResult = { link: LinkView; created: boolean };

type LinkRow = typeof link.$inferSelect;

function parseId(id: unknown): string {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw new NotFoundError("Link not found");
  return parsed.data;
}

function contentView(content: LinkContent | null): LinkView["content"] {
  if (!content) return null;
  return { byline: content.byline, site: content.site, paragraphs: content.paragraphs ?? [] };
}

function toView(row: LinkRow, tags: TagView[], summary: SummaryView | null): LinkView {
  return {
    id: row.id,
    url: row.url,
    host: row.host,
    finalUrl: row.finalUrl,
    title: row.title,
    siteName: row.siteName,
    excerpt: row.excerpt,
    content: contentView(row.content),
    wordCount: row.wordCount,
    status: row.status,
    failCode: row.failCode,
    readAt: row.readAt,
    archivedAt: row.archivedAt,
    favorite: row.favorite,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tags,
    summary,
  };
}

async function summariesFor(ownerId: string, linkIds: string[]): Promise<Map<string, SummaryView>> {
  const map = new Map<string, SummaryView>();
  if (linkIds.length === 0) return map;
  const rows = await db()
    .select()
    .from(linkSummary)
    .where(and(eq(linkSummary.ownerId, ownerId), inArray(linkSummary.linkId, linkIds)));
  for (const row of rows) {
    const parsed = storedSummarySchema.safeParse(row.data);
    const mode = row.mode === "live" || row.mode === "demo" || row.mode === "skipped" ? row.mode : "pending";
    const usable = parsed.success && (mode === "live" || mode === "demo");
    map.set(row.linkId, {
      mode,
      summary: usable ? parsed.data.summary : null,
      keyPoints: usable ? parsed.data.keyPoints : [],
      kind: usable ? parsed.data.kind : null,
      lowQuality: usable ? parsed.data.lowQuality : false,
      generatedAt: row.generatedAt,
      regenerationsLeft: Math.max(0, MAX_REGENERATIONS - row.regenerations),
    });
  }
  return map;
}

async function tagsFor(ownerId: string, linkIds: string[]): Promise<Map<string, TagView[]>> {
  const map = new Map<string, TagView[]>();
  if (linkIds.length === 0) return map;
  const rows = await db()
    .select({ linkId: linkTag.linkId, id: tag.id, name: tag.name, source: linkTag.source })
    .from(linkTag)
    .innerJoin(tag, eq(tag.id, linkTag.tagId))
    .where(and(eq(linkTag.ownerId, ownerId), inArray(linkTag.linkId, linkIds)));
  for (const row of rows) {
    const list = map.get(row.linkId) ?? [];
    list.push({ id: row.id, name: row.name, source: row.source });
    map.set(row.linkId, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return map;
}

async function oneView(row: LinkRow): Promise<LinkView> {
  const [tags, summaries] = await Promise.all([tagsFor(row.ownerId, [row.id]), summariesFor(row.ownerId, [row.id])]);
  return toView(row, tags.get(row.id) ?? [], summaries.get(row.id) ?? null);
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  let raw = "";
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new BadRequestError("Invalid cursor");
  }
  const pipe = raw.lastIndexOf("|");
  const iso = raw.slice(0, pipe);
  const id = raw.slice(pipe + 1);
  const createdAt = new Date(iso);
  if (pipe < 0 || !z.uuid().safeParse(id).success || Number.isNaN(createdAt.getTime())) {
    throw new BadRequestError("Invalid cursor");
  }
  return { createdAt, id };
}

/** Own links, newest first. `q` switches to ranked full-text search and ignores the cursor. */
export async function listLinks(actor: Actor, input: unknown = {}): Promise<{ links: LinkView[]; nextCursor: string | null }> {
  assertCan(actor, "read", { ownerId: actor.id });
  const query = listInput.parse(input);
  const q = query.q && query.q.length > 0 ? query.q : undefined;
  const extra: SQL[] = [];
  if (query.view === "inbox") extra.push(and(isNull(link.archivedAt), isNull(link.readAt)) as SQL);
  if (query.view === "archive") extra.push(isNotNull(link.archivedAt));
  if (query.view === "favorites") extra.push(eq(link.favorite, true));
  if (query.tag) {
    extra.push(sql`exists (
      select 1 from link_tag
      inner join tag on tag.id = link_tag.tag_id
      where link_tag.link_id = ${link.id} and tag.owner_id = ${actor.id} and tag.name = ${query.tag}
    )`);
  }
  const tsq = q ? sql`websearch_to_tsquery('simple', ${q})` : null;
  if (tsq) extra.push(sql`${link.search} @@ ${tsq}`);
  if (!q && query.cursor) {
    const cursor = decodeCursor(query.cursor);
    extra.push(sql`(${link.createdAt}, ${link.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`);
  }
  const rows = await db()
    .select()
    .from(link)
    .where(ownedBy(link, actor, ...extra))
    .orderBy(...(tsq ? [sql`ts_rank(${link.search}, ${tsq}) desc`, desc(link.createdAt), desc(link.id)] : [desc(link.createdAt), desc(link.id)]))
    .limit(query.limit + 1);
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const ids = page.map((row) => row.id);
  const [tags, summaries] = await Promise.all([tagsFor(actor.id, ids), summariesFor(actor.id, ids)]);
  return {
    links: page.map((row) => toView(row, tags.get(row.id) ?? [], summaries.get(row.id) ?? null)),
    nextCursor: !q && hasMore ? encodeCursor(page[page.length - 1]) : null,
  };
}

export async function getLink(actor: Actor, id: unknown): Promise<LinkView> {
  assertCan(actor, "read", { ownerId: actor.id });
  const linkId = parseId(id);
  const [row] = await db().select().from(link).where(ownedBy(link, actor, eq(link.id, linkId))).limit(1);
  if (!row) throw new NotFoundError("Link not found");
  return oneView(row);
}

async function assertSaveRate(tx: Tx, userId: string): Promise<void> {
  await advisoryLock(tx, `rate:save:${userId}`);
  const recent = (window: SQL) =>
    tx
      .select({ n: count() })
      .from(rateEvent)
      .where(and(eq(rateEvent.userId, userId), eq(rateEvent.kind, "save"), gt(rateEvent.at, window)));
  const [{ n: hour }] = await recent(sql`now() - interval '1 hour'`);
  if (Number(hour) >= LIMITS.savesPerHour) throw new TooManyRequestsError("You can save 60 links per hour.");
  const [{ n: day }] = await recent(sql`now() - interval '1 day'`);
  if (Number(day) >= LIMITS.savesPerDay) throw new TooManyRequestsError("You can save 300 links per day.");
  await consumeRate(tx, userId, "save", LIMITS.savesPerDay, "You can save 300 links per day.", { windowSeconds: 86_400 });
}

// The app-wide advisory lock serializes every save's queue check. That is acceptable at this scale (a few
// users, 60 saves/hour each); revisit with a counter row or per-shard locks if save traffic grows.
async function assertQueueRoom(tx: Tx, userId: string): Promise<void> {
  await advisoryLock(tx, "queue:app");
  const [{ mine }] = await tx
    .select({ mine: count() })
    .from(job)
    .where(and(eq(job.ownerId, userId), eq(job.status, "queued")));
  if (Number(mine) >= LIMITS.queuedPerUser) {
    throw new TooManyRequestsError("You have 50 links waiting to be fetched. Try again when some finish.");
  }
  const [{ all }] = await tx.select({ all: count() }).from(job).where(eq(job.status, "queued"));
  if (Number(all) >= LIMITS.queuedApp) throw new HttpError(503, "Busy, try again shortly");
}

async function assertLinkCap(tx: Tx, userId: string, adding: number): Promise<void> {
  const [{ n }] = await tx.select({ n: count() }).from(link).where(eq(link.ownerId, userId));
  if (Number(n) + adding > LIMITS.linksPerUser) {
    throw new ConflictError(`You can save at most ${LIMITS.linksPerUser} links.`);
  }
}

function fixtureValues(ownerId: string, article: FixtureArticle) {
  return {
    ownerId,
    url: article.url,
    urlHash: article.urlHash,
    host: article.host,
    title: article.title.slice(0, 300),
    siteName: article.siteName.slice(0, 120),
    excerpt: article.excerpt,
    content: { byline: article.byline, site: article.siteName, paragraphs: article.paragraphs, text: article.text } satisfies LinkContent,
    wordCount: article.wordCount,
    // Text is already stored, so these skip the fetch and go straight to the summarize job (offline in demo mode).
    status: "extracted" as const,
    failCode: null,
  };
}

/** Insert or refresh fixture articles for one owner. No network and no fetch job. Returns how many links were written. */
export async function upsertFixtures(tx: Tx, ownerId: string): Promise<number> {
  await advisoryLock(tx, `link-save:${ownerId}`);
  const existing = await tx.select({ id: link.id, urlHash: link.urlHash }).from(link).where(eq(link.ownerId, ownerId));
  const byHash = new Map(existing.map((row) => [row.urlHash, row.id]));
  const adding = FIXTURES.filter((article) => !byHash.has(article.urlHash)).length;
  await assertLinkCap(tx, ownerId, adding);
  for (const article of FIXTURES) {
    const values = fixtureValues(ownerId, article);
    const current = byHash.get(article.urlHash);
    if (current) {
      await tx
        .update(link)
        .set({ ...values, updatedAt: sql`now()` })
        .where(and(eq(link.id, current), eq(link.ownerId, ownerId)));
      await tx
        .delete(job)
        .where(and(eq(job.ownerId, ownerId), eq(job.kind, "fetch"), eq(job.key, current), sql`${job.status} in ('queued', 'running')`));
      await enqueue(tx, { kind: "summarize", key: current, ownerId, payload: { linkId: current } });
    } else {
      const [row] = await tx.insert(link).values(values).returning({ id: link.id });
      await enqueue(tx, { kind: "summarize", key: row.id, ownerId, payload: { linkId: row.id } });
    }
  }
  return FIXTURES.length;
}

/**
 * Save a URL for the actor. The same normalized URL returns the existing link.
 * A bundled fixture is stored with its text and gets a summarize job, with no fetch. Anything else is queued and a fetch job is enqueued.
 */
export async function saveLink(actor: Actor, input: unknown): Promise<SaveResult> {
  assertCan(actor, "create");
  const data = saveLinkInput.parse(input);
  const normalized = normalizeUrl(data.url);
  const fixture = fixtureByUrl.get(normalized.url);
  const saved = await db().transaction(async (tx) => {
    await advisoryLock(tx, `link-save:${actor.id}`);
    const [existing] = await tx
      .select()
      .from(link)
      .where(and(eq(link.ownerId, actor.id), eq(link.urlHash, normalized.urlHash)))
      .limit(1);
    if (existing) return { row: existing, created: false };
    await assertLinkCap(tx, actor.id, 1);
    await assertSaveRate(tx, actor.id);
    await assertQueueRoom(tx, actor.id);
    if (fixture) {
      const [row] = await tx.insert(link).values(fixtureValues(actor.id, fixture)).returning();
      await enqueue(tx, { kind: "summarize", key: row.id, ownerId: actor.id, payload: { linkId: row.id } });
      return { row, created: true };
    }
    const [row] = await tx
      .insert(link)
      .values({ ownerId: actor.id, url: normalized.url, urlHash: normalized.urlHash, host: normalized.host, status: "queued" })
      .returning();
    await enqueue(tx, { kind: "fetch", key: row.id, ownerId: actor.id, payload: { linkId: row.id } });
    return { row, created: true };
  });
  log.info("link.saved", { host: normalized.host, created: saved.created, status: saved.row.status });
  return { link: await oneView(saved.row), created: saved.created };
}

async function replaceUserTags(tx: Tx, actor: Actor, linkId: string, names: string[]): Promise<void> {
  const unique = [...new Set(names)];
  await advisoryLock(tx, `tags:${actor.id}`);
  const owned = await tx.select({ id: tag.id, name: tag.name }).from(tag).where(eq(tag.ownerId, actor.id));
  const byName = new Map(owned.map((row) => [row.name, row.id]));
  const missing = unique.filter((name) => !byName.has(name));
  if (owned.length + missing.length > LIMITS.tagsPerUser) {
    throw new ConflictError(`You can have at most ${LIMITS.tagsPerUser} tags.`);
  }
  for (const name of missing) {
    const [created] = await tx.insert(tag).values({ ownerId: actor.id, name }).returning({ id: tag.id });
    byName.set(name, created.id);
  }
  await tx.delete(linkTag).where(and(eq(linkTag.linkId, linkId), eq(linkTag.ownerId, actor.id), eq(linkTag.source, "user")));
  if (unique.length === 0) return;
  // A name the model already attached stays; the primary key is (link, tag), so don't insert it twice.
  const attached = await tx.select({ tagId: linkTag.tagId }).from(linkTag).where(and(eq(linkTag.linkId, linkId), eq(linkTag.ownerId, actor.id)));
  const have = new Set(attached.map((row) => row.tagId));
  const rows = unique
    .map((name) => byName.get(name))
    .filter((id): id is string => id !== undefined && !have.has(id))
    .map((tagId) => ({ linkId, tagId, ownerId: actor.id, source: "user" as const }));
  if (rows.length > 0) await tx.insert(linkTag).values(rows);
}

export async function patchLink(actor: Actor, id: unknown, input: unknown): Promise<LinkView> {
  assertCan(actor, "update", { ownerId: actor.id });
  const linkId = parseId(id);
  const data = patchLinkInput.parse(input);
  const row = await db().transaction(async (tx) => {
    const [current] = await tx.select({ id: link.id }).from(link).where(ownedBy(link, actor, eq(link.id, linkId))).limit(1);
    if (!current) throw new NotFoundError("Link not found");
    await tx
      .update(link)
      .set({
        ...(data.archived !== undefined ? { archivedAt: data.archived ? sql`now()` : null } : {}),
        ...(data.favorite !== undefined ? { favorite: data.favorite } : {}),
        ...(data.read !== undefined ? { readAt: data.read ? sql`now()` : null } : {}),
        updatedAt: sql`now()`,
      })
      .where(ownedBy(link, actor, eq(link.id, linkId)));
    if (data.tags) await replaceUserTags(tx, actor, linkId, data.tags);
    const [updated] = await tx.select().from(link).where(ownedBy(link, actor, eq(link.id, linkId))).limit(1);
    if (!updated) throw new NotFoundError("Link not found");
    return updated;
  });
  return oneView(row);
}

export async function deleteLink(actor: Actor, id: unknown): Promise<void> {
  assertCan(actor, "delete", { ownerId: actor.id });
  const linkId = parseId(id);
  const removed = await db().transaction(async (tx) => {
    const [row] = await tx.delete(link).where(ownedBy(link, actor, eq(link.id, linkId))).returning({ id: link.id });
    if (!row) return false;
    await tx.delete(job).where(and(eq(job.key, linkId), eq(job.ownerId, actor.id)));
    return true;
  });
  if (!removed) throw new NotFoundError("Link not found");
}

export async function listTags(actor: Actor): Promise<{ id: string; name: string; count: number }[]> {
  assertCan(actor, "read", { ownerId: actor.id });
  const rows = await db()
    .select({ id: tag.id, name: tag.name, count: count(linkTag.linkId) })
    .from(tag)
    .leftJoin(linkTag, and(eq(linkTag.tagId, tag.id), eq(linkTag.ownerId, actor.id)))
    .where(eq(tag.ownerId, actor.id))
    .groupBy(tag.id, tag.name)
    .orderBy(tag.name);
  return rows.map((row) => ({ id: row.id, name: row.name, count: Number(row.count) }));
}
