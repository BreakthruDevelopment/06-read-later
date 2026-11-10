import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import type { LinkContent } from "@/lib/db/schema";
import { extractHtml, type ExtractedPage } from "@/lib/fetch/extract";
import { claimHost, HOST_BUSY_DEFER_MS, releaseHost } from "@/lib/fetch/host";
import { readFetchedPage, type PageFetcher } from "@/lib/fetch/page";
import { fixtureByUrl, type FixtureArticle } from "@/lib/links/fixtures";
import { LIMITS } from "@/lib/limits";
import { log } from "@/lib/log";
import { SafeFetchError } from "@/lib/safe-fetch";
import { safeErrorFields } from "@/lib/safe-error";
import { releaseDaily, reserveDaily } from "@/lib/usage";
import { enqueue } from "@/lib/jobs/queue";
import { JobError, type JobContext, type JobHandler, type JobInfo } from "@/lib/jobs/worker";

const { link } = schema;

/** The daily cap resets at UTC midnight. An hour is the longest a single defer may wait. */
const FETCH_CAP_DEFER_MS = 60 * 60 * 1000;

const OPEN = sql`${link.status} in ('queued', 'fetching', 'failed')`;

type LinkRef = { id: string; ownerId: string; url: string; host: string; status: string };

export type FetchDeps = {
  /** Test seam. Production uses the SSRF-safe fetcher. */
  fetch?: PageFetcher;
  allowedPorts?: number[];
};

export function createFetchHandler(deps: FetchDeps = {}): JobHandler {
  return (job, ctx) => runFetch(job, ctx, deps);
}

export const fetchLinkHandler = createFetchHandler();

/**
 * Fetch one saved link and store plain paragraphs. Idempotent: a job can run twice after a crash.
 * Logs the host and a short code only — never the URL, whose path may hold a token.
 */
async function runFetch(job: JobInfo, ctx: JobContext, deps: FetchDeps): Promise<void> {
  const linkId = linkIdOf(job);
  if (!linkId || !job.ownerId) throw new JobError("bad_payload", { permanent: true });
  const ownerId = job.ownerId;
  const row = await loadLink(linkId, ownerId);
  if (!row) return;
  if (row.status === "summarizing" || row.status === "ready") return;
  if (row.status === "extracted") {
    await enqueueSummarize(ownerId, linkId);
    return;
  }

  const fixture = fixtureByUrl.get(row.url);
  if (fixture) {
    await storeFixture(row, fixture);
    return;
  }

  const lease = await claimHost(row.host);
  if (!lease) {
    log.info("fetch.deferred", { host: row.host, code: "host_busy" });
    throw new JobError("host_busy", { deferMs: HOST_BUSY_DEFER_MS });
  }

  let counted = false;
  try {
    const reserved = await reserveDaily(db(), "fetch", LIMITS.fetchDaily);
    if (!reserved) {
      log.info("fetch.deferred", { host: row.host, code: "fetch_cap" });
      throw new JobError("fetch_cap", { deferMs: FETCH_CAP_DEFER_MS });
    }
    counted = true;
    if (!(await setStatus(row, "fetching"))) {
      await releaseDaily(db(), "fetch");
      return;
    }

    const page = await readFetchedPage(row.url, ctx.signal, deps);
    if (ctx.signal.aborted) throw new JobError("timeout");
    assertHttp(page.status);
    const extracted = extractHtml(page.html);
    if (!extracted.ok) throw new JobError("no_text", { permanent: true });
    if (ctx.signal.aborted) throw new JobError("timeout");

    const saved = await storeExtracted(row, extracted.page, page.finalUrl);
    if (!saved) return;
    await enqueueSummarize(ownerId, linkId);
    log.info("fetch.done", { host: row.host, bytes: page.bytes });
  } catch (err) {
    if (isDatabaseError(err)) throw err;
    if (err instanceof JobError && err.deferMs !== undefined) throw err;
    const failure = classify(err);
    if (failure.code === "blocked_address" && counted) {
      try {
        await releaseDaily(db(), "fetch");
      } catch (releaseErr) {
        log.warn("fetch.release_failed", { host: row.host, ...safeErrorFields(releaseErr) });
      }
    }
    const giveUp = failure.permanent || ctx.attempt >= ctx.maxAttempts;
    if (giveUp) await setFailed(row, failure.code);
    else await setStatus(row, "queued");
    log.warn("fetch.failed", { host: row.host, code: failure.code });
    throw new JobError(failure.code, { permanent: failure.permanent });
  } finally {
    try {
      await releaseHost(row.host, lease);
    } catch (err) {
      log.error("fetch.host_release_failed", { host: row.host, ...safeErrorFields(err) });
    }
  }
}

function linkIdOf(job: JobInfo): string | null {
  const key = typeof job.key === "string" && z.uuid().safeParse(job.key).success ? job.key : null;
  const raw = job.payload.linkId;
  const payload = typeof raw === "string" && z.uuid().safeParse(raw).success ? raw : null;
  if (key && payload && key !== payload) return null;
  return key ?? payload;
}

function assertHttp(status: number): void {
  if (status === 429) throw new JobError("http_429");
  if (status >= 500) throw new JobError("http_5xx");
  if (status < 200 || status >= 300) throw new JobError("http_4xx", { permanent: true });
}

function classify(err: unknown): { code: string; permanent: boolean } {
  if (err instanceof JobError) return { code: err.code, permanent: err.permanent };
  if (err instanceof SafeFetchError) {
    switch (err.code) {
      case "blocked":
      case "bad_url":
        return { code: "blocked_address", permanent: true };
      case "too_large":
        return { code: "too_large", permanent: true };
      case "bad_content_type":
        return { code: "bad_content_type", permanent: true };
      case "too_many_redirects":
        return { code: "too_many_redirects", permanent: true };
      case "timeout":
        return { code: "timeout", permanent: false };
      case "dns":
        return { code: "dns", permanent: false };
      default:
        return { code: "network", permanent: false };
    }
  }
  return { code: "network", permanent: false };
}

function isDatabaseError(err: unknown): boolean {
  return safeErrorFields(err).error === "database query failed";
}

async function loadLink(id: string, ownerId: string): Promise<LinkRef | null> {
  const [row] = await db()
    .select({ id: link.id, ownerId: link.ownerId, url: link.url, host: link.host, status: link.status })
    .from(link)
    .where(and(eq(link.id, id), eq(link.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

async function setStatus(row: LinkRef, status: "queued" | "fetching"): Promise<boolean> {
  const rows = await db()
    .update(link)
    .set({ status, failCode: null, updatedAt: sql`now()` })
    .where(and(eq(link.id, row.id), eq(link.ownerId, row.ownerId), OPEN))
    .returning({ id: link.id });
  return rows.length > 0;
}

async function setFailed(row: LinkRef, code: string): Promise<void> {
  await db()
    .update(link)
    .set({ status: "failed", failCode: code, updatedAt: sql`now()` })
    .where(and(eq(link.id, row.id), eq(link.ownerId, row.ownerId), OPEN));
}

async function storeExtracted(row: LinkRef, page: ExtractedPage, finalUrl: string): Promise<boolean> {
  const content: LinkContent = {
    ...(page.byline ? { byline: page.byline } : {}),
    ...(page.site ? { site: page.site } : {}),
    paragraphs: page.paragraphs,
    text: page.text,
  };
  const rows = await db()
    .update(link)
    .set({
      status: "extracted",
      failCode: null,
      title: page.title,
      siteName: page.site,
      excerpt: page.excerpt,
      content,
      wordCount: page.wordCount,
      finalUrl: /^https?:\/\//.test(finalUrl) && finalUrl.length <= 2048 ? finalUrl : null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(link.id, row.id), eq(link.ownerId, row.ownerId), OPEN))
    .returning({ id: link.id });
  return rows.length > 0;
}

async function storeFixture(row: LinkRef, article: FixtureArticle): Promise<void> {
  const content: LinkContent = {
    byline: article.byline,
    site: article.siteName,
    paragraphs: article.paragraphs,
    text: article.text,
  };
  await db()
    .update(link)
    .set({
      title: article.title.slice(0, 300),
      siteName: article.siteName.slice(0, 120),
      excerpt: article.excerpt,
      content,
      wordCount: article.wordCount,
      status: "ready",
      failCode: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(link.id, row.id), eq(link.ownerId, row.ownerId)));
}

async function enqueueSummarize(ownerId: string, linkId: string): Promise<void> {
  await enqueue(db(), { kind: "summarize", key: linkId, ownerId, payload: { linkId } });
}
