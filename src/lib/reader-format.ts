/** Display helpers for the library pages. No database and no HTML. */

export const LINK_STATUSES = ["queued", "fetching", "extracted", "summarizing", "ready", "failed"] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

/** Inbox and reader poll while a link is unfinished, then stop. */
export const STATUS_POLL_MS = 3_000;
export const STATUS_POLL_BUDGET_MS = 120_000;

const TAG_NAME = /^[a-z0-9][a-z0-9-]{1,23}$/;

export type ChipTone = "live" | "building" | "failed" | "not-started";

export const SUMMARY_FAILED = "summary_failed";

const FAIL_LABELS: Record<string, string> = {
  blocked_address: "That address can't be fetched.",
  timeout: "The site took too long to respond.",
  too_large: "The page is too large to save.",
  too_complex: "The page is too complex to read.",
  too_many_redirects: "The page redirected too many times.",
  bad_content_type: "That page isn't HTML or plain text.",
  http_4xx: "The site refused the page.",
  http_5xx: "The site had an error.",
  dns: "The site's address didn't resolve.",
  network: "The site couldn't be reached.",
  no_text: "Couldn't extract readable text.",
  host_busy: "That site is busy right now. Try again in a few minutes.",
  fetch_cap: "Today's page-fetch limit was reached. Try again tomorrow.",
  lease_expired: "The fetch was interrupted before it finished. Retry it.",
};

export function isLinkStatus(value: unknown): value is LinkStatus {
  return typeof value === "string" && (LINK_STATUSES as readonly string[]).includes(value);
}

export function isUnfinished(status: LinkStatus): boolean {
  return status !== "ready" && status !== "failed";
}

/** About 200 words a minute, rounded to the nearest minute, at least one when there is text. */
export function readingMinutes(wordCount: number | null | undefined): number | null {
  if (wordCount == null || wordCount < 1) return null;
  return Math.max(1, Math.round(wordCount / 200));
}

export function readingLabel(wordCount: number | null | undefined): string | null {
  const minutes = readingMinutes(wordCount);
  return minutes == null ? null : `${minutes} min`;
}

export function failLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return FAIL_LABELS[code] ?? "The page couldn't be fetched.";
}

/**
 * Chip label for a link status. After the poll window a still-queued link uses the
 * scale-to-zero message: it finishes on the next visit.
 */
export function statusPresentation(status: LinkStatus, gaveUp: boolean): { tone: ChipTone; label: string } {
  if (gaveUp && isUnfinished(status)) {
    return {
      tone: status === "queued" ? "not-started" : "building",
      label: "Finishes next time you open the app",
    };
  }
  switch (status) {
    case "queued":
      return { tone: "building", label: "Queued" };
    case "fetching":
      return { tone: "building", label: "Fetching" };
    case "extracted":
      return { tone: "building", label: "Extracted" };
    case "summarizing":
      return { tone: "building", label: "Summarizing" };
    case "ready":
      return { tone: "live", label: "Ready" };
    case "failed":
      return { tone: "failed", label: "Failed" };
  }
}

/** First string query value, trimmed. Empty becomes undefined. */
export function oneString(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * A same-app path to return to after sign-in. Rejects other sites, including a
 * URL hidden in the query's path or in percent-encoding.
 */
export function safeNext(value: string | undefined): string {
  if (!value || value.length > 8192) return "/inbox";
  if (!isAppPath(value)) return "/inbox";
  try {
    if (!isAppPath(decodeURIComponent(value))) return "/inbox";
  } catch {
    return "/inbox";
  }
  return value;
}

function isAppPath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return false;
  if (/[\u0000-\u001f]/.test(value)) return false;
  const path = value.split("?")[0] ?? "";
  return !path.includes(":") && !path.includes("//");
}

/** Split a tag box into unique lowercase slugs. Invalid names are left for the caller to reject. */
export function parseTagList(raw: string): string[] {
  const names = raw
    .split(/[\s,]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  return [...new Set(names)];
}

export function invalidTag(name: string): boolean {
  return !TAG_NAME.test(name);
}

/**
 * Bookmarklet for this deployment. Null when the public URL could break out of the
 * quoted JavaScript string.
 */
export function bookmarkletHref(appUrl: string): string | null {
  const origin = appUrl.replace(/\/$/, "");
  if (!origin.startsWith("https://") && !origin.startsWith("http://")) return null;
  if (origin.includes("'") || origin.includes("\\") || /[\u0000-\u001f]/.test(origin)) return null;
  return `javascript:location.href='${origin}/save?url='+encodeURIComponent(location.href)`;
}
