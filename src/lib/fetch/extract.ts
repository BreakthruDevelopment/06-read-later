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

export type ExtractResult = { ok: true; page: ExtractedPage } | { ok: false; code: "no_text" };

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
 * Readable text only. Readability runs first (it does not execute scripts). When it finds nothing, visible text
 * with the tags stripped is used, and under 200 characters of that is `no_text`. Output is capped at 100 KB.
 */
export function extractHtml(html: string): ExtractResult {
  const article = readArticle(html);
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

function readArticle(html: string): Article | null {
  try {
    const document = dom(html);
    return new Readability(document, { charThreshold: 0, maxElemsToParse: 50_000 }).parse();
  } catch {
    return null;
  }
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
