import { normalizeUrl, type NormalizedUrl } from "./url";

export type FixtureArticle = NormalizedUrl & {
  title: string;
  siteName: string;
  byline: string;
  paragraphs: string[];
  text: string;
  excerpt: string;
  wordCount: number;
};

const ARTICLES: { url: string; title: string; siteName: string; byline: string; paragraphs: string[] }[] = [
  {
    url: "https://example.com/read-later/postgres-indexes",
    title: "How Postgres indexes speed up queries",
    siteName: "Example",
    byline: "Demo Author",
    paragraphs: [
      "A Postgres index lets the database find rows without reading the whole table.",
      "B-tree indexes are the default and fit equality and range filters.",
      "This demo article is stored with the app so search works without fetching a network.",
    ],
  },
  {
    url: "https://example.com/read-later/small-teams",
    title: "How small teams ship reliable software",
    siteName: "Example",
    byline: "Demo Author",
    paragraphs: [
      "Small teams ship reliable software by automating tests and deploys.",
      "A short checklist before each release catches the mistakes a tired afternoon would miss.",
      "Deploy small changes often, and roll back when the health check fails.",
    ],
  },
  {
    url: "https://example.com/read-later/quiet-reading",
    title: "A quieter way to read the web",
    siteName: "Example",
    byline: "Demo Author",
    paragraphs: [
      "Save a link when you find it, then read the text later without the clutter around it.",
      "Tags can wait until the article is actually worth filing.",
    ],
  },
];

function build(article: (typeof ARTICLES)[number]): FixtureArticle {
  const normalized = normalizeUrl(article.url);
  const text = article.paragraphs.join("\n\n");
  const excerpt = text.replace(/\s+/g, " ").trim().slice(0, 300);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return { ...article, ...normalized, text, excerpt, wordCount };
}

/** Pre-extracted articles. Saving one of these URLs stores the text and does not fetch. */
export const FIXTURES: FixtureArticle[] = ARTICLES.map(build);

export const fixtureByUrl = new Map(FIXTURES.map((article) => [article.url, article]));

/** Smoke searches for this one. */
export const DEMO_SEARCH_URL = FIXTURES[0].url;
