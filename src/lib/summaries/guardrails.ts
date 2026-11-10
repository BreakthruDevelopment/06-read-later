import { z } from "zod";

/**
 * Code-side guardrails for `summarize-link`. The model's answer is untrusted: the page it read may have tried to steer it.
 * Everything here is a pure function so the evals can run it without a database or a model.
 *
 * Output is display-only text. The reader UI must render it as text (React escaping), never as HTML or Markdown.
 */

export const TAG_NAME = /^[a-z0-9][a-z0-9-]{1,23}$/;
export const KINDS = ["article", "news", "tutorial", "reference", "opinion", "product", "other"] as const;

export const MAX_SUMMARY_CHARS = 600;
export const MAX_KEY_POINT_CHARS = 160;
export const MAX_KEY_POINTS = 5;
export const MAX_TAGS = 5;
/** When the user already has tags, the model may add at most this many new ones to one link. */
export const MAX_NEW_TAGS = 2;
export const SUMMARY_UNAVAILABLE = "Summary unavailable";

/**
 * What we accept from the model. Looser than what we store (long strings, free-form tags) so one over-long field
 * doesn't throw away an otherwise good answer; `applyGuardrails` clamps everything to `storedSummarySchema`.
 * Unknown keys (an obedient model inventing `actions` or `links`) are dropped by the parse.
 */
export const modelSummarySchema = z.object({
  summary: z.string().min(1).max(3000),
  keyPoints: z.array(z.string().min(1).max(600)).max(10).catch([]),
  tags: z.array(z.string().min(1).max(80)).max(10).catch([]),
  kind: z.enum(KINDS).catch("other"),
  lowQuality: z.boolean().catch(false), // paywall, cookie wall or error page
});
export type ModelSummary = z.infer<typeof modelSummarySchema>;

/** What is stored in `link_summary.data`: the spec's schema (tags may be empty when every one was refused). */
export const storedSummarySchema = z.object({
  summary: z.string().min(1).max(MAX_SUMMARY_CHARS),
  keyPoints: z.array(z.string().min(1).max(MAX_KEY_POINT_CHARS)).max(MAX_KEY_POINTS).catch([]),
  tags: z.array(z.string().regex(TAG_NAME)).max(MAX_TAGS),
  kind: z.enum(KINDS).catch("other"),
  lowQuality: z.boolean().catch(false),
});
export type StoredSummary = z.infer<typeof storedSummarySchema>;

export type GuardrailCode =
  | "url_stripped"
  | "markup_stripped"
  | "summary_replaced"
  | "cta_removed"
  | "ungrounded_number"
  | "summary_truncated"
  | "tag_invalid"
  | "tag_blocked"
  | "tag_limit"
  | "new_tag_limit";

/** Small on purpose: nsfw-style labels and a few slurs. Extend it here; tags matching any dash-separated part are dropped. */
const TAG_BLOCKLIST = new Set([
  "nsfw", "porn", "porno", "xxx", "nude", "nudes", "hentai", "erotic", "gore", "explicit", "fetish",
  "retard", "retarded", "faggot", "tranny",
]);

const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const SCHEME_URL = /\b[a-z][a-z0-9+.-]{1,20}:\/\/\S+/gi;
const PSEUDO_URL = /\b(?:javascript|data|mailto|tel|file):\S*/gi;
const WWW_URL = /\bwww\.\S+/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const BARE_DOMAIN =
  /\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|dev|app|co|me|ly|info|biz|xyz|example|test|edu|gov|ru|cn|tk|ml|ga|cf|gq|top|site|online|link|click|zip)\b(?:[/:?#]\S*)?/gi;

const CTA_VERB =
  "log ?in|sign ?in|sign ?up|click|tap|visit|go to|navigate to|download|install|open|enter|verify|confirm|follow|subscribe|call|email|send|submit|reply|register|contact|buy|purchase|pay|share|forward|copy|paste|reset|update your";
const CTA_ANYWHERE = new RegExp(`\\b(?:${CTA_VERB})\\b`, "i");
const CTA_IMPERATIVE_START = new RegExp(`^(?:(?:please|kindly|now|also|then|and)[,\\s]+)*(?:${CTA_VERB})\\b`, "i");
const CTA_ADDRESSED = new RegExp(
  `\\b(?:please|kindly|(?:you|reader|readers|user|users)\\s+(?:must|should|need to|needs to|have to|can|may|will need to|are asked to|are advised to|are required to))\\b[^.!?]*\\b(?:${CTA_VERB})\\b`,
  "i",
);

/** Count of characters removed by a replace, summed over every match. */
function strip(text: string, pattern: RegExp, replacement = " "): { text: string; removed: number } {
  let removed = 0;
  const out = text.replace(pattern, (m) => {
    removed += m.length;
    return replacement;
  });
  return { text: out, removed };
}

type Cleaned = { text: string; urlRemoved: number; markup: boolean };

/** Remove markup, Markdown links, URLs and email addresses from one piece of text. */
function cleanText(input: string): Cleaned {
  let text = input.normalize("NFKC").replace(INVISIBLE, " ");
  const tagStrip = strip(text, /<[^>]*>/g);
  let markup = tagStrip.removed > 0;
  text = tagStrip.text;
  if (/[<>]/.test(text)) markup = true;
  text = text.replace(/[<>]/g, " ");
  let urlRemoved = 0;
  const image = strip(text, MARKDOWN_IMAGE); // an image is a request to the attacker's server: drop it, label and all
  text = image.text;
  urlRemoved += image.removed;
  text = text.replace(MARKDOWN_LINK, (m, label: string) => {
    urlRemoved += m.length - label.length;
    return label;
  });
  for (const pattern of [SCHEME_URL, PSEUDO_URL, WWW_URL, EMAIL, BARE_DOMAIN]) {
    const r = strip(text, pattern);
    text = r.text;
    urlRemoved += r.removed;
  }
  text = text
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
  return { text, urlRemoved, markup };
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

/** "1.200", "1,200" and "1200" are the same number; this is how we compare a figure with the article's. */
function digitRuns(text: string): Set<string> {
  const compact = text.normalize("NFKC").replace(/(?<=\d)[.,](?=\d)/g, "");
  return new Set(compact.match(/\d+/g) ?? []);
}

function ungroundedNumber(sentence: string, known: Set<string>): boolean {
  for (const run of digitRuns(sentence)) {
    if (run.length >= 2 && !known.has(run)) return true;
  }
  return false;
}

/** A sentence that carried a link and points the reader at it ("see", "details at") is a lure even without an action verb. */
const POINTS_AT_LINK = /\b(?:see|check|find|read|view|access|head|learn|more (?:info|information|details)|details|status|verify)\b/i;

function isCallToAction(sentence: string, hadUrl: boolean, strict: boolean): boolean {
  if (hadUrl && (CTA_ANYWHERE.test(sentence) || POINTS_AT_LINK.test(sentence))) return true;
  if (CTA_ADDRESSED.test(sentence)) return true;
  // Key points are often imperative ("Deploy small changes often"), so only the summary gets the start-of-sentence rule.
  return strict && CTA_IMPERATIVE_START.test(sentence);
}

type Field = { text: string | null; codes: Set<GuardrailCode> };

/**
 * Clean one summary or key point: strip markup and links, drop sentences that tell the reader to act or state
 * figures the article never contains. Returns null when nothing usable is left (over half stripped, or empty).
 */
function guardField(raw: string, known: Set<string>, strict: boolean): Field {
  const codes = new Set<GuardrailCode>();
  const original = raw.normalize("NFKC").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  const whole = cleanText(raw);
  if (whole.markup) codes.add("markup_stripped");
  if (whole.urlRemoved > 0) codes.add("url_stripped");
  if (original.length > 0 && whole.urlRemoved / original.length > 0.5) {
    codes.add("summary_replaced");
    return { text: null, codes };
  }
  const kept: string[] = [];
  for (const sentence of splitSentences(raw.normalize("NFKC").replace(INVISIBLE, " ").replace(/<[^>]*>/g, " "))) {
    const cleaned = cleanText(sentence);
    if (!cleaned.text) continue;
    if (isCallToAction(cleaned.text, cleaned.urlRemoved > 0, strict)) {
      codes.add("cta_removed");
      continue;
    }
    if (ungroundedNumber(cleaned.text, known)) {
      codes.add("ungrounded_number");
      continue;
    }
    kept.push(cleaned.text);
  }
  const text = kept.join(" ").trim();
  return { text: text.length > 0 ? text : null, codes };
}

/** Cut at the last sentence end that fits, else the last word, adding an ellipsis. Never longer than `max`. */
export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = text.slice(0, max);
  const sentenceEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (sentenceEnd > max * 0.5) return { text: head.slice(0, sentenceEnd + 1), truncated: true };
  const room = text.slice(0, max - 1);
  const space = room.lastIndexOf(" ");
  return { text: `${(space > max * 0.5 ? room.slice(0, space) : room).replace(/[\s,;:.-]+$/, "")}…`, truncated: true };
}

/** A short topical slug, or null when nothing usable remains. Never contains markup. */
export function slugifyTag(input: string): string | null {
  const slug = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return TAG_NAME.test(slug) ? slug : null;
}

export type TagChoice = { name: string; isNew: boolean };

export function chooseTags(candidates: string[], existingTags: readonly string[]): { tags: TagChoice[]; codes: Set<GuardrailCode> } {
  const codes = new Set<GuardrailCode>();
  const existing = new Set(existingTags);
  const maxNew = existing.size > 0 ? MAX_NEW_TAGS : MAX_TAGS;
  const seen = new Set<string>();
  const valid: TagChoice[] = [];
  for (const candidate of candidates) {
    const slug = slugifyTag(candidate);
    if (!slug) {
      codes.add("tag_invalid");
      continue;
    }
    if (slug.split("-").some((part) => TAG_BLOCKLIST.has(part)) || TAG_BLOCKLIST.has(slug.replace(/-/g, ""))) {
      codes.add("tag_blocked");
      continue;
    }
    if (seen.has(slug)) continue;
    seen.add(slug);
    valid.push({ name: slug, isNew: !existing.has(slug) });
  }
  // Prefer tags the user already has, then new ones up to the cap.
  const ordered = [...valid.filter((t) => !t.isNew), ...valid.filter((t) => t.isNew)];
  const tags: TagChoice[] = [];
  let added = 0;
  for (const tag of ordered) {
    if (tags.length >= MAX_TAGS) {
      codes.add("tag_limit");
      break;
    }
    if (tag.isNew) {
      if (added >= maxNew) {
        codes.add(existing.size > 0 ? "new_tag_limit" : "tag_limit");
        continue;
      }
      added += 1;
    }
    tags.push(tag);
  }
  return { tags, codes };
}

export type GuardedSummary = { data: StoredSummary; tags: TagChoice[]; codes: GuardrailCode[] };

/**
 * Turn the model's answer into what we store and show. `articleText` is the text the model was given (figures in the
 * summary must appear in it); `existingTags` are the names offered to the model.
 */
export function applyGuardrails(raw: ModelSummary, articleText: string, existingTags: readonly string[]): GuardedSummary {
  const known = digitRuns(articleText);
  const codes = new Set<GuardrailCode>();

  const summaryField = guardField(raw.summary, known, true);
  summaryField.codes.forEach((c) => codes.add(c));
  let summary = summaryField.text ?? SUMMARY_UNAVAILABLE;
  if (summaryField.text === null) codes.add("summary_replaced");
  const cut = truncateText(summary, MAX_SUMMARY_CHARS);
  if (cut.truncated) codes.add("summary_truncated");
  summary = cut.text;

  const keyPoints: string[] = [];
  for (const point of raw.keyPoints) {
    if (keyPoints.length >= MAX_KEY_POINTS) break;
    const field = guardField(point, known, false);
    field.codes.forEach((c) => codes.add(c));
    if (!field.text) continue;
    const short = truncateText(field.text, MAX_KEY_POINT_CHARS);
    if (short.truncated) codes.add("summary_truncated");
    keyPoints.push(short.text);
  }

  const chosen = chooseTags(raw.tags, existingTags);
  chosen.codes.forEach((c) => codes.add(c));

  const data = storedSummarySchema.parse({
    summary,
    keyPoints,
    tags: chosen.tags.map((t) => t.name),
    kind: raw.kind,
    lowQuality: raw.lowQuality,
  });
  return { data, tags: chosen.tags, codes: [...codes].sort() };
}
