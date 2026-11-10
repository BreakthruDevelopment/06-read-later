import type { Metadata } from "next";
import { FilterBar, PageIntro } from "@/components/ui";
import { LibraryView } from "@/components/library/library-view";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { oneString } from "@/lib/reader-format";

export const metadata: Metadata = { title: "Search" };
export const dynamic = "force-dynamic";

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  await requireUserOrRedirect("/search");
  const q = oneString((await searchParams).q);
  const results = q
    ? await LibraryView({
        section: "Search",
        title: "Results",
        description: "Matches from your library.",
        view: "all",
        query: q,
        empty: `No matches for "${q.slice(0, 80)}".`,
        morePath: "/search",
        listTitle: "Results",
        showIntro: false,
      })
    : null;

  return (
    <>
      <PageIntro section="Search" title="Search" description="Search your own titles and article text." />
      <FilterBar search={{ value: q ?? "", placeholder: "Search your library" }} label="Search your library" />
      {results ?? <p className="text-sm text-muted">Enter a word from a title or from the saved text.</p>}
    </>
  );
}
