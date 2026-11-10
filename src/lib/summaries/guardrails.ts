import { z } from "zod";
import { TLDS } from "./tlds";

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
  | "phone_removed"
  | "markup_stripped"
  | "summary_replaced"
  | "sentence_dropped"
  | "cta_removed"
  | "ungrounded_number"
  | "summary_truncated"
  | "tag_invalid"
  | "tag_blocked"
  | "tag_limit"
  | "new_tag_limit";

/**
 * Small on purpose: nsfw-style labels and a few slurs. Extend it here. A tag is refused when any entry appears in it
 * (dashes removed, digit-for-letter swaps undone), so `p0rn` and `hardcore-porn` go the same way as `porn`.
 */
const TAG_BLOCKLIST = [
  "nsfw", "porn", "xxx", "nude", "hentai", "erotic", "gore", "explicit", "fetish",
  "retard", "faggot", "tranny",
];

const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/**
 * Cyrillic and Greek letters that look like Latin ones, lowercase (input is lowercased first). Enough to turn a
 * look-alike domain such as "раураl.com" back into the ASCII name it imitates.
 */
const LOOKALIKES: Record<string, string> = {
  а: "a", в: "b", с: "c", ԁ: "d", е: "e", ё: "e", к: "k", ӏ: "l", м: "m", н: "h", о: "o", р: "p", ԛ: "q", ѕ: "s",
  т: "t", у: "y", х: "x", і: "i", ї: "i", ј: "j", һ: "h", ԝ: "w", ь: "b", ґ: "r", ᴀ: "a", ɡ: "g",
  α: "a", β: "b", γ: "y", ε: "e", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ω: "w", η: "n", μ: "u",
};
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKES).join("")}]`, "g");

/** Dots written so a filter will not see them: "[.]", "(.)", "{.}", "。", "｡", " dot ", "[dot]", "(dot)". */
const OBFUSCATED_DOT = /\s*(?:\[\s*\.\s*\]|\(\s*\.\s*\)|\{\s*\.\s*\}|\[\s*dot\s*\]|\(\s*dot\s*\)|[。｡．]|\s+dot\s+)\s*/g;
const DOMAIN_TOKEN = /[a-z0-9\u00a1-\uffff_-]+(?:\.[a-z0-9\u00a1-\uffff_-]+)+/g;
/** "http://", "hxxps[:]//", "ftp ://": a scheme, however it is spelled. */
const SCHEME_FRAGMENT = /\b[a-z]{3,10}\s*[[(]?:[\])]?\s*\/\//;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
/** Seven or more digits, with single separators allowed between them: a phone, account or card number. */
const PHONE_SHAPED = /\d(?:[\s().+-]?\d){6,}/;
const SECOND_PERSON = /\byou(?:r|rs|rself|rselves)?\b|\byou['’](?:re|ll|ve|d)\b/;
const CREDENTIAL =
  /\b(?:password|passcode|pin|log[\s-]?in|log[\s-]?on|signin|sign[\s-]?in|verify|verif(?:ies|ied|ying|ication)|account number|card number|ssn|social security|wire|gift card|bitcoin|crypto(?:currency)?(?: wallet)?|seed phrase)\b/;

/** Base-form verbs that begin an instruction ("Sign in…", "Deploy small changes…"). */
const IMPERATIVE_VERBS = new Set(
  `sign log click tap press visit go navigate download install open enter verify confirm follow subscribe call phone email text
  send submit reply register contact buy purchase pay share forward copy paste reset update upgrade check see read learn find use
  try get make take keep add remove delete run build deploy automate water feed pinch stake plant grow avoid ensure remember consider start stop create set write
  choose pick select apply review watch listen look note notice ignore skip consult ask tell give let put turn move change fix
  test measure monitor track compare split join save store rename drop limit prefer maintain define design plan prepare configure
  enable disable allow protect secure back migrate import export clear clean wait expect assume treat think begin finish launch
  publish upload scan wipe lock unlock activate claim redeem win earn invest trust act hurry order book attend reach stay do don't
  never always be beware warn report access provide include mention paste unsubscribe approve accept agree grant complete fill`
    .split(/\s+/)
    .filter(Boolean),
);
const LEAD_IN = /^(?:["'“”‘’(\-*•\d.)\s]*)(?:(?:please|kindly|now|also|then|and|just|first|next|finally)[,\s]+)*/;

export type DropReason = "url" | "phone" | "markup" | "second_person" | "credential" | "imperative";

function variants(sentence: string): string[] {
  const base = sentence.normalize("NFKC").toLowerCase().replace(INVISIBLE, " ");
  const mapped = base.replace(LOOKALIKE_RE, (c) => LOOKALIKES[c] ?? c);
  return mapped === base ? [base] : [base, mapped];
}

function looksLikeDomain(text: string): boolean {
  const flat = text.replace(OBFUSCATED_DOT, ".");
  for (const token of flat.match(DOMAIN_TOKEN) ?? []) {
    const last = token.slice(token.lastIndexOf(".") + 1);
    if (TLDS.has(last)) return true;
  }
  return false;
}

/**
 * Why a sentence must not be shown, or null when it is clean. A summary cannot be templated, so we do not try to
 * clean a risky sentence: it is dropped whole. Risky means it contains a domain-like token (obfuscated or imitated
 * with look-alike letters), a URL scheme, an email address, markup, a phone- or card-shaped number, second person
 * ("you", "your"), a credential or payment word, or it starts as an instruction.
 */
export function riskyReason(sentence: string): DropReason | null {
  for (const v of variants(sentence)) {
    if (/[<>]/.test(v) || /\]\(|!\[/.test(v)) return "markup";
    if (v.includes("@") || SCHEME_FRAGMENT.test(v) || looksLikeDomain(v)) return "url";
    if (PHONE_SHAPED.test(v.replace(ISO_DATE, " "))) return "phone";
    if (SECOND_PERSON.test(v)) return "second_person";
    if (CREDENTIAL.test(v)) return "credential";
    const first = v.replace(LEAD_IN, "").match(/^[a-z']+/)?.[0];
    if (first && IMPERATIVE_VERBS.has(first)) return "imperative";
  }
  return null;
}

function splitSentences(text: string): string[] {
  // Split after a sentence end that is followed by the start of a new sentence, so "evil [ . ] com" stays in one piece.
  return text
    .split(/(?<=[.!?。！？])\s+(?=[A-Z0-9"'“‘(\u00c0-\u024f]|$)|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
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

const REASON_CODE: Record<DropReason, GuardrailCode> = {
  url: "url_stripped",
  phone: "phone_removed",
  markup: "markup_stripped",
  second_person: "cta_removed",
  credential: "cta_removed",
  imperative: "cta_removed",
};

type Field = { text: string | null; codes: Set<GuardrailCode> };

/** Keep the clean sentences of one summary or key point; null when none is left. */
function guardField(raw: string, known: Set<string>): Field {
  const codes = new Set<GuardrailCode>();
  const kept: string[] = [];
  for (const sentence of splitSentences(raw.normalize("NFKC").replace(INVISIBLE, " "))) {
    const reason = riskyReason(sentence);
    if (reason) {
      codes.add(REASON_CODE[reason]);
      codes.add("sentence_dropped");
      continue;
    }
    if (ungroundedNumber(sentence, known)) {
      codes.add("ungrounded_number");
      codes.add("sentence_dropped");
      continue;
    }
    kept.push(sentence.replace(/\s+/g, " "));
  }
  const text = kept.join(" ").trim();
  // Defense in depth: what is left, read as a whole, must still be clean (a link or number cannot hide across a split).
  const whole = text.length > 0 ? riskyReason(text) : null;
  if (whole) {
    codes.add(REASON_CODE[whole]);
    codes.add("sentence_dropped");
    return { text: null, codes };
  }
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

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", $: "s", "@": "a" };

/**
 * A short topical slug, or null. `<…>` is removed first, and anything with a non-ASCII character is refused outright
 * (look-alike letters such as Cyrillic "о" in "pоrn" are how a filter gets evaded), never transliterated.
 */
export function slugifyTag(input: string): string | null {
  const text = input.replace(/<[^>]*>/g, " ");
  if (/[^\u0000-\u007f]/.test(text)) return null;
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return TAG_NAME.test(slug) ? slug : null;
}

function isBlockedTag(raw: string, slug: string): boolean {
  return [slug, raw.replace(/<[^>]*>/g, " ").toLowerCase()].some((form) => {
    const letters = form.replace(/[^a-z0-9$@]/g, "");
    const unswapped = letters.replace(/[0-9$@]/g, (c) => LEET[c] ?? c);
    return TAG_BLOCKLIST.some((term) => letters.includes(term) || unswapped.includes(term));
  });
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
      // Non-ASCII look-alikes ("nѕfw") are refused rather than cleaned, so they count as blocked, not just malformed.
      codes.add(/[^\u0000-\u007f]/.test(candidate) ? "tag_blocked" : "tag_invalid");
      continue;
    }
    if (isBlockedTag(candidate, slug)) {
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

export type GuardedSummary = {
  data: StoredSummary;
  tags: TagChoice[];
  codes: GuardrailCode[];
  /** No clean sentence was left in the summary: show nothing from the model (`data` holds "Summary unavailable"). */
  rejected: boolean;
};

/**
 * Turn the model's answer into what we store and show. `articleText` is the text the model was given (figures in the
 * summary must appear in it); `existingTags` are the names offered to the model. When every sentence of the summary
 * had to be dropped the whole answer is rejected: no key points, no tags, and the caller stores nothing.
 */
export function applyGuardrails(raw: ModelSummary, articleText: string, existingTags: readonly string[]): GuardedSummary {
  const known = digitRuns(articleText);
  const codes = new Set<GuardrailCode>();

  const summaryField = guardField(raw.summary, known);
  summaryField.codes.forEach((c) => codes.add(c));
  if (summaryField.text === null) {
    codes.add("summary_replaced");
    const data = storedSummarySchema.parse({ summary: SUMMARY_UNAVAILABLE, keyPoints: [], tags: [], kind: raw.kind, lowQuality: raw.lowQuality });
    return { data, tags: [], codes: [...codes].sort(), rejected: true };
  }
  const cut = truncateText(summaryField.text, MAX_SUMMARY_CHARS);
  if (cut.truncated) codes.add("summary_truncated");

  const keyPoints: string[] = [];
  for (const point of raw.keyPoints) {
    if (keyPoints.length >= MAX_KEY_POINTS) break;
    const field = guardField(point, known);
    field.codes.forEach((c) => codes.add(c));
    if (!field.text) continue;
    const short = truncateText(field.text, MAX_KEY_POINT_CHARS);
    if (short.truncated) codes.add("summary_truncated");
    keyPoints.push(short.text);
  }

  const chosen = chooseTags(raw.tags, existingTags);
  chosen.codes.forEach((c) => codes.add(c));

  const data = storedSummarySchema.parse({
    summary: cut.text,
    keyPoints,
    tags: chosen.tags.map((t) => t.name),
    kind: raw.kind,
    lowQuality: raw.lowQuality,
  });
  return { data, tags: chosen.tags, codes: [...codes].sort(), rejected: false };
}
