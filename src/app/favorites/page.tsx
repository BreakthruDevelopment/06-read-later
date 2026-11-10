import type { Metadata } from "next";
import { LibraryView } from "@/components/library/library-view";
import { oneString } from "@/lib/reader-format";

export const metadata: Metadata = { title: "Favorites" };
export const dynamic = "force-dynamic";

export default async function FavoritesPage({ searchParams }: { searchParams: Promise<{ cursor?: string | string[] }> }) {
  const cursor = oneString((await searchParams).cursor);
  return LibraryView({
    section: "Favorites",
    title: "Favorites",
    description: "Links you marked to come back to.",
    view: "favorites",
    cursor,
    empty: "No favorites yet.",
    morePath: "/favorites",
  });
}
