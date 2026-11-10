import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

/** Stored text cap from the spec. The reader renders these paragraphs, never HTML. */
export const MAX_TEXT_BYTES = 100_000;
const MIN_FALLBACK_CHARS = 200;
const TITLE_CHARS = 300;
const SITE_CHARS = 120;
const BYLINE_CHARS = 200;
const EXCERPT_CHARS = 300;

export type ExtractedPage = {
  title: string | null;
  byline: string | null;
  site: string | null;
  paragraphs: string[];
  text: string;
  excerpt: string;
  wordCount: number;
};

export type ExtractResult = { ok: true; page: ExtractedPage } | { ok: false; code: "no_text" | "too_complex" };

/** Readability and linkedom run on the event loop and grow worse than linearly with nesting, so bound the input. */
export const MAX_DEPTH = 500;
export const MAX_ELEMENTS = 20_000;

type Article = {
  title?: string | null;
  byline?: string | null;
  siteName?: string | null;
  content?: string | null;
  textContent?: string | null;
};

/** Decode a response body from the Content-Type charset or a `<meta charset>`, defaulting to UTF-8. */
export function decodePage(body: Buffer, contentType: string | undefined): string {
  const header = charsetFrom(contentType);
  const sniff = body.subarray(0, 4096).toString("latin1");
  const label = header ?? charsetFromMeta(sniff) ?? "utf-8";
  try {
    return new TextDecoder(label, { fatal: false }).decode(body);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(body);
  }
}

/**
 * A `text/plain` response has no markup: Readability would find nothing and the DOM fallback has no text node to read.
 * Paragraphs are the blocks separated by blank lines, with the same cleaning and 100 KB cap as HTML. Under 200
 * characters is `no_text`, as for HTML.
 */
export function extractPlainText(text: string): ExtractResult {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n[^\S\n]*\n/)
    .map(clean)
    .filter((paragraph) => paragraph.length > 0);
  if (capParagraphs(paragraphs).join("\n\n").length < MIN_FALLBACK_CHARS) return { ok: false, code: "no_text" };
  return finish(paragraphs, { documentTitle: null });
}

/** The media type of a Content-Type header, lowercased and without parameters. */
export function mediaTypeOf(contentType: string | undefined): string {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/**
 * Readable text only. Readability runs first (it does not execute scripts). When it finds nothing, visible text
 * with the tags stripped is used, and under 200 characters of that is `no_text`. Output is capped at 100 KB.
 */
export function extractHtml(html: string): ExtractResult {
  // Cheap linear scan of the raw markup first: parsing 60,000 nested divs already takes seconds, and Readability
  // on the result takes minutes, all synchronously.
  if (!withinLimits(html)) return { ok: false, code: "too_complex" };
  const parsed = parseBounded(html);
  if (parsed === "too_complex") return { ok: false, code: "too_complex" };
  const article = readArticle(parsed);
  const readable = article && clean(article.textContent ?? "").length > 0 ? article : null;
  if (readable) {
    const fromContent = readable.content ? paragraphsIn(dom(`<article>${readable.content}</article>`)) : [];
    const paragraphs = fromContent.length > 0 ? fromContent : paragraphsIn(textDocument(readable.textContent ?? ""));
    return finish(paragraphs, {
      title: readable.title,
      byline: readable.byline,
      site: readable.siteName,
      documentTitle: titleTag(html),
    });
  }

  const document = dom(html);
  stripHidden(document);
  const paragraphs = paragraphsIn(document);
  const text = capParagraphs(paragraphs).join("\n\n");
  if (text.length < MIN_FALLBACK_CHARS) return { ok: false, code: "no_text" };
  return finish(paragraphs, { title: titleTag(html), documentTitle: null });
}

/** Keep paragraphs until their joined UTF-8 size reaches `maxBytes`. */
export function capParagraphs(paragraphs: string[], maxBytes = MAX_TEXT_BYTES): string[] {
  const out: string[] = [];
  let used = 0;
  for (const paragraph of paragraphs) {
    const sep = out.length > 0 ? 2 : 0;
    const size = Buffer.byteLength(paragraph);
    if (used + sep + size <= maxBytes) {
      out.push(paragraph);
      used += sep + size;
      continue;
    }
    const room = maxBytes - used - sep;
    if (room > 0) {
      const cut = truncateUtf8(paragraph, room);
      if (cut) out.push(cut);
    }
    break;
  }
  return out;
}

function finish(
  paragraphs: string[],
  meta: { title?: string | null; byline?: string | null; site?: string | null; documentTitle: string | null },
): ExtractResult {
  const capped = capParagraphs(paragraphs);
  const text = capped.join("\n\n");
  if (!text) return { ok: false, code: "no_text" };
  const title = clip(meta.title, TITLE_CHARS) ?? clip(meta.documentTitle, TITLE_CHARS);
  const byline = clip(meta.byline, BYLINE_CHARS);
  const site = clip(meta.site, SITE_CHARS);
  const flat = text.replace(/\s+/g, " ").trim();
  return {
    ok: true,
    page: {
      title,
      byline,
      site,
      paragraphs: capped,
      text,
      excerpt: flat.slice(0, EXCERPT_CHARS),
      wordCount: flat.split(/\s+/).filter(Boolean).length,
    },
  };
}

function readArticle(document: Document | null): Article | null {
  if (!document) return null;
  try {
    return new Readability(document, { charThreshold: 0, maxElemsToParse: MAX_ELEMENTS }).parse();
  } catch {
    return null;
  }
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
const RAW_CLOSE: Record<string, RegExp> = Object.fromEntries([...RAW_TEXT].map((name) => [name, new RegExp(`</${name}`, "gi")]));
const OPEN_END = /[^>]{0,4096}>/y;
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)|<!--/g;

/**
 * True when the markup has at most MAX_ELEMENTS tags and nests no deeper than MAX_DEPTH, judged by a single pass
 * that never builds a tree. Script and style bodies and comments are skipped, so markup inside them is not counted.
 */
export function withinLimits(html: string): boolean {
  let depth = 0;
  let count = 0;
  TAG.lastIndex = 0;
  for (let m = TAG.exec(html); m; m = TAG.exec(html)) {
    if (m[0] === "<!--") {
      const end = html.indexOf("-->", TAG.lastIndex);
      if (end < 0) return true;
      TAG.lastIndex = end + 3;
      continue;
    }
    const name = m[2].toLowerCase();
    if (m[1]) {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (VOID.has(name)) continue;
    count += 1;
    if (count > MAX_ELEMENTS) return false;
    if (RAW_TEXT.has(name)) {
      const close = RAW_CLOSE[name];
      close.lastIndex = TAG.lastIndex;
      const end = close.exec(html);
      if (!end) return true;
      TAG.lastIndex = end.index;
      continue;
    }
    // Bounded lookahead: a self-closing `<path/>` opens nothing. Never scan further than one tag's worth.
    OPEN_END.lastIndex = TAG.lastIndex;
    if (OPEN_END.exec(html)?.[0].endsWith("/>")) continue;
    depth += 1;
    if (depth > MAX_DEPTH) return false;
  }
  return true;
}

/** Parse, then confirm on the real tree (the parser can nest more than the source suggests). Iterative: no recursion. */
function parseBounded(html: string): Document | "too_complex" | null {
  let document: Document;
  try {
    document = dom(html);
  } catch {
    return null;
  }
  const root = document.documentElement;
  if (!root) return document;
  let count = 0;
  const stack: { node: Element; depth: number }[] = [{ node: root, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: Element; depth: number };
    count += 1;
    if (count > MAX_ELEMENTS || depth > MAX_DEPTH) return "too_complex";
    for (let child = node.firstElementChild; child; child = child.nextElementSibling) {
      stack.push({ node: child, depth: depth + 1 });
    }
  }
  return document;
}

function titleTag(html: string): string | null {
  try {
    return dom(html).querySelector("title")?.textContent ?? null;
  } catch {
    return null;
  }
}

function dom(html: string): Document {
  return parseHTML(html).document as unknown as Document;
}

function textDocument(text: string): Document {
  const document = dom("<article></article>");
  const p = document.createElement("p");
  p.textContent = text;
  document.body?.appendChild(p);
  return document;
}

function stripHidden(document: Document): void {
  for (const node of document.querySelectorAll("script, style, noscript, template, svg")) node.remove();
}

function paragraphsIn(root: ParentNode): string[] {
  const paragraphs = [...root.querySelectorAll("p")]
    .map((node) => clean(node.textContent ?? ""))
    .filter((paragraph) => paragraph.length > 0);
  if (paragraphs.length > 0) return paragraphs;
  const blocks = [...root.querySelectorAll("li, h1, h2, h3, h4, h5, h6, blockquote, pre")]
    .map((node) => clean(node.textContent ?? ""))
    .filter((paragraph) => paragraph.length > 0);
  if (blocks.length > 0) return blocks;
  const text = clean(root.textContent ?? "");
  return text ? [text] : [];
}

function clean(value: string): string {
  return value.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

function clip(value: string | null | undefined, max: number): string | null {
  const cleaned = clean(value ?? "");
  if (!cleaned) return null;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buf = Buffer.from(value);
  if (buf.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8").trim();
}

function charsetFrom(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const match = /charset\s*=\s*["']?\s*([a-zA-Z0-9._:-]+)/i.exec(contentType);
  return match ? match[1] : null;
}

function charsetFromMeta(head: string): string | null {
  const match = /<meta\b[^>]*charset\s*=\s*["']?\s*([a-zA-Z0-9._:-]+)/i.exec(head);
  return match ? match[1] : null;
}
