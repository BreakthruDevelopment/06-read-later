import "server-only";
import { decodePage, mediaTypeOf } from "@/lib/fetch/extract";
import { safeFetch, type SafeFetchOptions, type SafeFetchResult } from "@/lib/safe-fetch";

export const FETCH_USER_AGENT =
  "Mozilla/5.0 (compatible; ReadLaterBot/1.0; +https://app6.breakthruventures.ai/bot)";

export const FETCH_HEADERS: Record<string, string> = {
  "user-agent": FETCH_USER_AGENT,
  accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
  "accept-encoding": "gzip, deflate, br",
};

export const ALLOWED_CONTENT_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];

const MAX_BYTES = 2 * 1024 * 1024;

export type FetchedPage = {
  status: number;
  html: string;
  /** Media type of the response, e.g. `text/plain`. */
  contentType: string;
  finalUrl: string;
  bytes: number;
};

export type PageFetcher = (input: string, opts?: SafeFetchOptions) => Promise<SafeFetchResult>;

/**
 * GET one saved URL. The caller passes the URL exactly as stored. Tests inject `fetch` (a stub resolver or a
 * local fixture server) and, when that server isn't on port 80/443, `allowedPorts`.
 */
export async function readFetchedPage(
  url: string,
  signal: AbortSignal,
  deps: { fetch?: PageFetcher; allowedPorts?: number[] } = {},
): Promise<FetchedPage> {
  const fetch = deps.fetch ?? safeFetch;
  const res = await fetch(url, {
    maxBytes: MAX_BYTES,
    timeoutMs: 8_000,
    connectTimeoutMs: 3_000,
    headersTimeoutMs: 5_000,
    maxRedirects: 3,
    signal,
    headers: FETCH_HEADERS,
    allowedContentTypes: [...ALLOWED_CONTENT_TYPES],
    ...(deps.allowedPorts ? { allowedPorts: deps.allowedPorts } : {}),
  });
  return {
    status: res.status,
    contentType: mediaTypeOf(res.headers["content-type"]),
    html: decodePage(res.body, res.headers["content-type"]),
    finalUrl: res.url,
    bytes: res.body.length,
  };
}
