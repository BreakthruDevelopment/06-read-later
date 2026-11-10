import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { AiError, isLiveProvider } from "@/lib/ai";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { ConflictError, NotFoundError, TooManyRequestsError } from "@/lib/errors";
import { enqueue } from "@/lib/jobs/queue";
import { JobError, type JobContext, type JobGiveUp, type JobHandler, type JobInfo } from "@/lib/jobs/worker";
import { LIMITS } from "@/lib/limits";
import { log } from "@/lib/log";
import { ownedBy } from "@/lib/owned";
import { safeErrorFields } from "@/lib/safe-error";
import { type Tx, advisoryLock, consumeRate, rateIsFull, releaseDaily, releaseRate, reserveDaily } from "@/lib/usage";
import type { StoredSummary } from "./guardrails";
import { MAX_REGENERATIONS } from "./limits";
import { articleHash, callSummaryModel, MAX_EXISTING_TAGS, prepareSummary, type SummaryDeps } from "./task";

const { link, linkSummary, linkTag, tag } = schema;

/** `fail_code` on a `ready` link whose summary could not be made. The article is still readable; Regenerate retries. */
export const SUMMARY_FAILED = "summary_failed";
export { MAX_REGENERATIONS };
/** Waiting for the hourly per-user cap, or the app-wide daily cap. `run_after` is a floor, not a deadline. */
const RATE_DEFER_MS = 5 * 60 * 1000;
const DAILY_CAP_DEFER_MS = 60 * 60 * 1000;
const QUOTA_DEFER_MS = 10 * 60 * 1000;
const STALE_DEFER_MS = 1_000;

export type SummaryMode = "live" | "demo" | "skipped" | "pending";

function linkIdOf(job: JobInfo): string | null {
  const key = typeof job.key === "string" && z.uuid().safeParse(job.key).success ? job.key : null;
  const raw = job.payload.linkId;
  const payload = typeof raw === "string" && z.uuid().safeParse(raw).success ? raw : null;
  if (key && payload && key !== payload) return null;
  return key ?? payload;
}

export function createSummarizeHandler(deps: SummaryDeps = {}): JobHandler {
  return (job, ctx) => runSummarize(job, ctx, deps);
}

export const summarizeLinkHandler = createSummarizeHandler();

/**
 * The summarize job is out of attempts (or its worker was killed on the last one). The article is already stored and
 * readable, so the link goes to `ready` with `fail_code = summary_failed`; the owner can press Regenerate.
 */
export const giveUpSummarize: JobGiveUp = async (job) => {
  const linkId = linkIdOf(job);
  if (!linkId || !job.ownerId) return;
  await db()
    .update(link)
    .set({ status: "ready", failCode: SUMMARY_FAILED, updatedAt: sql`now()` })
    .where(and(eq(link.id, linkId), eq(link.ownerId, job.ownerId), sql`${link.status} in ('extracted', 'summarizing')`));
};

async function existingTagNames(ownerId: string): Promise<string[]> {
  const rows = await db()
    .select({ name: tag.name, uses: sql<number>`count(${linkTag.linkId})` })
    .from(tag)
    .leftJoin(linkTag, and(eq(linkTag.tagId, tag.id), eq(linkTag.ownerId, ownerId)))
    .where(eq(tag.ownerId, ownerId))
    .groupBy(tag.id, tag.name)
    .orderBy(desc(sql`count(${linkTag.linkId})`), tag.name)
    .limit(MAX_EXISTING_TAGS);
  return rows.map((r) => r.name);
}

async function markReady(linkId: string, ownerId: string): Promise<void> {
  await db()
    .update(link)
    .set({ status: "ready", failCode: null, updatedAt: sql`now()` })
    .where(and(eq(link.id, linkId), eq(link.ownerId, ownerId), sql`${link.status} in ('extracted', 'summarizing')`));
}

/**
 * Summarize one extracted link and tag it. Idempotent: the job is keyed by link, and the summary row stores a hash of
 * the text the model saw, so a re-run (crash after the write, a second fetch of unchanged text) does nothing.
 * A re-run with changed text summarizes again; so does a Regenerate request (`payload.regenerate`).
 * Logs the task, mode, host, sizes and guardrail codes; never the title, the text or the URL.
 */
async function runSummarize(job: JobInfo, ctx: JobContext, deps: SummaryDeps): Promise<void> {
  const linkId = linkIdOf(job);
  if (!linkId || !job.ownerId) throw new JobError("bad_payload", { permanent: true });
  const ownerId = job.ownerId;
  const [row] = await db()
    .select({ id: link.id, host: link.host, status: link.status, title: link.title, siteName: link.siteName, content: link.content })
    .from(link)
    .where(and(eq(link.id, linkId), eq(link.ownerId, ownerId)))
    .limit(1);
  // Not extracted yet, failed, or deleted meanwhile: nothing to do. A `ready` link is only re-summarized by a Regenerate.
  if (!row || (row.status !== "extracted" && row.status !== "summarizing")) return;

  const text = row.content?.text ?? row.content?.paragraphs?.join("\n\n") ?? "";
  const article = { title: row.title, site: row.siteName ?? row.content?.site, byline: row.content?.byline, text };
  const hash = articleHash(article);
  const force = job.payload.regenerate === true;
  const since = typeof job.payload.since === "number" ? job.payload.since : 0;

  const [current] = await db().select().from(linkSummary).where(and(eq(linkSummary.linkId, linkId), eq(linkSummary.ownerId, ownerId))).limit(1);
  if (current && current.mode !== "pending" && current.inputHash === hash && (!force || current.generatedAt.getTime() >= since)) {
    await markReady(linkId, ownerId);
    log.info("summarize.unchanged", { task: "summarize-link", host: row.host });
    return;
  }

  await db()
    .update(link)
    .set({ status: "summarizing", failCode: null, updatedAt: sql`now()` })
    .where(and(eq(link.id, linkId), eq(link.ownerId, ownerId), eq(link.status, "extracted")));

  const existing = await existingTagNames(ownerId);
  const prepared = prepareSummary(article, existing);
  if (prepared.skip) {
    await db().transaction((tx) => writeSummary(tx, { linkId, ownerId, hash, mode: "skipped", data: {}, tags: [] }));
    log.info("summarize.skipped", { task: "summarize-link", mode: "skipped", host: row.host, chars: prepared.textChars });
    return;
  }

  // Limits: the per-user hourly cap for every call, the app-wide daily cap for live model calls only.
  try {
    await db().transaction((tx) => consumeRate(tx, ownerId, "summarize", LIMITS.summariesPerHour, "Too many summaries this hour."));
  } catch (err) {
    if (err instanceof TooManyRequestsError) {
      log.info("summarize.deferred", { host: row.host, code: "rate_limited" });
      throw new JobError("rate_limited", { deferMs: RATE_DEFER_MS });
    }
    throw err;
  }
  const live = isLiveProvider();
  const refund = async () => {
    await db().transaction((tx) => releaseRate(tx, ownerId, "summarize"));
    if (live) await releaseDaily(db(), "summarize");
  };
  if (live && !(await reserveDaily(db(), "summarize", LIMITS.summaryDaily))) {
    await db().transaction((tx) => releaseRate(tx, ownerId, "summarize"));
    log.info("summarize.deferred", { host: row.host, code: "summary_cap" });
    throw new JobError("summary_cap", { deferMs: DAILY_CAP_DEFER_MS });
  }

  let result;
  try {
    result = await callSummaryModel(prepared, existing, deps);
  } catch (err) {
    await refund().catch((e) => log.error("summarize.refund_failed", safeErrorFields(e)));
    const kind = err instanceof AiError ? err.kind : "provider";
    log.warn("summarize.failed", { task: "summarize-link", host: row.host, kind });
    if (kind === "input_rejected") throw new JobError("ai_input_rejected", { permanent: true });
    if (kind === "quota") throw new JobError("ai_quota", { deferMs: QUOTA_DEFER_MS });
    throw new JobError(kind === "invalid_output" ? "ai_invalid_output" : "ai_failed");
  }
  // The call took the whole time box: the worker already counted this attempt as timed out, so don't write behind its back.
  if (ctx.signal.aborted) throw new JobError("timeout");
  // A live-configured app that fell back to the recorded answer did not use a live call.
  if (live && result.demo) await releaseDaily(db(), "summarize").catch(() => undefined);

  const stale = await db().transaction(async (tx) => {
    const [fresh] = await tx
      .select({ title: link.title, siteName: link.siteName, content: link.content, status: link.status })
      .from(link)
      .where(and(eq(link.id, linkId), eq(link.ownerId, ownerId)))
      .for("update")
      .limit(1);
    if (!fresh || (fresh.status !== "extracted" && fresh.status !== "summarizing")) return "gone";
    const freshText = fresh.content?.text ?? fresh.content?.paragraphs?.join("\n\n") ?? "";
    if (articleHash({ title: fresh.title, site: fresh.siteName ?? fresh.content?.site, byline: fresh.content?.byline, text: freshText }) !== hash) return "changed";
    await writeSummary(tx, { linkId, ownerId, hash, mode: result.demo ? "demo" : "live", data: result.data, tags: result.tags.map((t) => t.name) });
    return null;
  });
  // The text was replaced while the model worked: this answer is for the old text. Run again on the new one.
  if (stale === "changed") throw new JobError("stale", { deferMs: STALE_DEFER_MS });
  if (stale === "gone") return;
  log.info("summarize.done", {
    task: "summarize-link",
    mode: result.demo ? "demo" : "live",
    host: row.host,
    chars: prepared.prompt.length,
    latencyMs: result.latencyMs,
    codes: result.codes,
  });
}

type WriteInput = {
  linkId: string;
  ownerId: string;
  hash: string;
  mode: SummaryMode;
  data: StoredSummary | Record<string, never>;
  tags: string[];
};

/** Store the summary, replace the model's tags on the link, and mark it ready, all or nothing. */
async function writeSummary(tx: Tx, w: WriteInput): Promise<void> {
  await tx
    .insert(linkSummary)
    .values({ linkId: w.linkId, ownerId: w.ownerId, data: w.data, mode: w.mode, inputHash: w.hash })
    .onConflictDoUpdate({
      target: linkSummary.linkId,
      set: { data: w.data, mode: w.mode, inputHash: w.hash, generatedAt: sql`now()` },
    });

  await advisoryLock(tx, `tags:${w.ownerId}`);
  await tx.delete(linkTag).where(and(eq(linkTag.linkId, w.linkId), eq(linkTag.ownerId, w.ownerId), eq(linkTag.source, "ai")));
  if (w.tags.length > 0) {
    const owned = await tx.select({ id: tag.id, name: tag.name }).from(tag).where(eq(tag.ownerId, w.ownerId));
    const byName = new Map(owned.map((t) => [t.name, t.id]));
    let room = LIMITS.tagsPerUser - owned.length;
    for (const name of w.tags) {
      if (byName.has(name) || room < 1) continue;
      const [created] = await tx.insert(tag).values({ ownerId: w.ownerId, name }).returning({ id: tag.id });
      byName.set(name, created.id);
      room -= 1;
    }
    const attached = await tx.select({ tagId: linkTag.tagId }).from(linkTag).where(and(eq(linkTag.linkId, w.linkId), eq(linkTag.ownerId, w.ownerId)));
    const have = new Set(attached.map((r) => r.tagId));
    const rows = w.tags
      .map((name) => byName.get(name))
      .filter((id): id is string => id !== undefined && !have.has(id))
      .map((tagId) => ({ linkId: w.linkId, tagId, ownerId: w.ownerId, source: "ai" as const }));
    if (rows.length > 0) await tx.insert(linkTag).values(rows);
  }

  await tx
    .update(link)
    .set({ status: "ready", failCode: null, updatedAt: sql`now()` })
    .where(and(eq(link.id, w.linkId), eq(link.ownerId, w.ownerId)));
}

export type RegenerateResult = { id: string; status: "summarizing"; regenerationsLeft: number };

/**
 * Owner asks for a fresh summary. At most 3 per link (counted when requested, not refunded if the job later fails), and
 * the hourly per-user cap is checked up front so the request says so instead of queuing a job that has to wait.
 * Anyone but the owner, an admin included, gets 404.
 */
export async function regenerateSummary(actor: Actor, id: unknown): Promise<RegenerateResult> {
  assertCan(actor, "update", { ownerId: actor.id });
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw new NotFoundError("Link not found");
  const linkId = parsed.data;
  const [mine] = await db().select({ id: link.id }).from(link).where(ownedBy(link, actor, eq(link.id, linkId))).limit(1);
  if (!mine) throw new NotFoundError("Link not found");
  if (await rateIsFull(actor.id, "summarize", LIMITS.summariesPerHour)) {
    throw new TooManyRequestsError("You can summarize 30 pages per hour. Try again later.");
  }
  return db().transaction(async (tx) => {
    await advisoryLock(tx, `summary:${linkId}`);
    const [row] = await tx
      .select({ status: link.status, hasText: sql<boolean>`${link.content} is not null` })
      .from(link)
      .where(ownedBy(link, actor, eq(link.id, linkId)))
      .limit(1);
    if (!row) throw new NotFoundError("Link not found");
    if (row.status === "extracted" || row.status === "summarizing") throw new ConflictError("A summary is already being made.");
    if (row.status !== "ready" || !row.hasText) throw new ConflictError("This link has no readable text to summarize.");
    const [existing] = await tx.select({ regenerations: linkSummary.regenerations }).from(linkSummary).where(eq(linkSummary.linkId, linkId)).limit(1);
    const used = existing?.regenerations ?? 0;
    if (used >= MAX_REGENERATIONS) throw new TooManyRequestsError("A summary can be regenerated 3 times.");
    const [{ since }] = await tx.execute<{ since: number }>(sql`select (extract(epoch from clock_timestamp()) * 1000)::float8 as since`);
    const queued = await enqueue(tx, { kind: "summarize", key: linkId, ownerId: actor.id, payload: { linkId, regenerate: true, since: Number(since) } });
    if (!queued.created) throw new ConflictError("A summary is already being made.");
    if (existing) {
      await tx.update(linkSummary).set({ regenerations: used + 1 }).where(eq(linkSummary.linkId, linkId));
    } else {
      // No summary yet (it failed, or never ran): a placeholder row keeps the count.
      await tx.insert(linkSummary).values({ linkId, ownerId: actor.id, data: {}, mode: "pending", inputHash: "", regenerations: 1 });
    }
    await tx
      .update(link)
      .set({ status: "summarizing", failCode: null, updatedAt: sql`now()` })
      .where(ownedBy(link, actor, eq(link.id, linkId)));
    return { id: linkId, status: "summarizing" as const, regenerationsLeft: MAX_REGENERATIONS - used - 1 };
  });
}
