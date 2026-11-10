import { describe, expect, it } from "vitest";
import { capParagraphs, decodePage, extractHtml, MAX_DEPTH, MAX_ELEMENTS, MAX_TEXT_BYTES, withinLimits } from "@/lib/fetch/extract";

const CANARY = "SCRIPT_CANARY_TOKEN";

function page(body: string, title = "Readable title"): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>
    <script>${CANARY}</script><style>${CANARY}</style>${body}</body></html>`;
}

describe("decodePage", () => {
  it("uses the header charset, then a meta charset, then utf-8", () => {
    expect(decodePage(Buffer.from("caf\xe9", "latin1"), "text/plain; charset=iso-8859-1")).toBe("café");
    const meta = Buffer.from('<meta charset="iso-8859-1"><p>caf\xe9</p>', "latin1");
    expect(decodePage(meta, "text/html")).toContain("café");
    expect(decodePage(Buffer.from("café", "utf8"), undefined)).toBe("café");
  });
});

describe("extractHtml", () => {
  it("keeps paragraphs and drops scripts and tags", () => {
    const html = page(`
      <article>
        <h1>How indexes work</h1>
        <p class="byline">Ada Lovelace</p>
        <p>A Postgres index lets the database find rows without reading the whole table.</p>
        <p>B-tree indexes are the default and fit equality and range filters.</p>
        <p>Hello <b>world</b> from the article body.</p>
      </article>
    `);
    const result = extractHtml(html);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const blob = JSON.stringify(result.page);
    expect(blob).not.toContain(CANARY);
    expect(blob).not.toContain("<b>");
    expect(blob).not.toContain("<script");
    expect(result.page.paragraphs.join(" ")).toContain("without reading the whole table");
    expect(result.page.paragraphs.join(" ")).toContain("Hello world from the article body");
    expect(result.page.paragraphs.join(" ")).toContain("indexes");
    expect(result.page.title).toBe("Readable title");
    expect(result.page.wordCount).toBeGreaterThan(10);
    expect(result.page.excerpt.length).toBeLessThanOrEqual(300);
  });

  it("returns no_text when Readability finds nothing and the visible text is under 200 characters", () => {
    const result = extractHtml(page("", "Hi"));
    expect(result).toEqual({ ok: false, code: "no_text" });
  });

  it("caps stored text at 100 KB", () => {
    const paragraphs = Array.from({ length: 40 }, () => "word ".repeat(600).trim());
    const capped = capParagraphs(paragraphs);
    const text = capped.join("\n\n");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(Buffer.byteLength(text)).toBeGreaterThan(MAX_TEXT_BYTES - 4_000);

    const html = page(paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join(""));
    const result = extractHtml(html);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.byteLength(result.page.text)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(result.page.text).not.toContain(CANARY);
  });
});

describe("extractHtml limits", () => {
  const timed = (html: string) => {
    const started = Date.now();
    const result = extractHtml(html);
    return { result, ms: Date.now() - started };
  };

  it("refuses 60,000 nested divs (660 KB) at once instead of freezing the process", () => {
    const n = 60_000;
    const { result, ms } = timed("<div>".repeat(n) + "some text inside the nest" + "</div>".repeat(n));
    expect(result).toEqual({ ok: false, code: "too_complex" });
    expect(ms).toBeLessThan(500);
  });

  it("refuses the largest nesting a 2 MB body can hold, and unclosed nesting", () => {
    const { result, ms } = timed("<div>".repeat(400_000));
    expect(result).toEqual({ ok: false, code: "too_complex" });
    expect(ms).toBeLessThan(500);
    expect(timed("<span><b><i>".repeat(100_000)).result).toEqual({ ok: false, code: "too_complex" });
  });

  it("refuses more than 20,000 elements, wide or with many tiny tags", () => {
    expect(timed("<p>x</p>".repeat(MAX_ELEMENTS + 1)).result).toEqual({ ok: false, code: "too_complex" });
    const { result, ms } = timed("<a<a<a<a".repeat(300_000));
    expect(ms).toBeLessThan(2_000);
    expect(result.ok).toBe(false);
  });

  it("still extracts a page at the limits", () => {
    const nested = "<div>".repeat(MAX_DEPTH - 10) + "<p>" + "A readable sentence about indexes. ".repeat(10) + "</p>" + "</div>".repeat(MAX_DEPTH - 10);
    const { result, ms } = timed(page(nested));
    expect(result.ok).toBe(true);
    expect(ms).toBeLessThan(3_000);
    const wide = timed(page(Array.from({ length: 5_000 }, (_, i) => `<p>Paragraph number ${i} about databases and indexes.</p>`).join("")));
    expect(wide.result.ok).toBe(true);
    expect(wide.ms).toBeLessThan(5_000);
  });

  it("does not count markup inside scripts, styles and comments, or self-closing tags", () => {
    expect(withinLimits("<script>" + "<div>".repeat(MAX_DEPTH + 10) + "</script><p>ok</p>")).toBe(true);
    expect(withinLimits("<!--" + "<div>".repeat(MAX_DEPTH + 10) + "--><p>ok</p>")).toBe(true);
    expect(withinLimits("<svg>" + '<path d="M0 0"/>'.repeat(MAX_DEPTH + 10) + "</svg>")).toBe(true);
    expect(withinLimits("<ul>" + "<li>a<br>b</li>".repeat(1000) + "</ul>")).toBe(true);
  });
});
