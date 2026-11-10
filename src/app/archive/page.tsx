import type { Metadata } from "next";
import { LibraryView } from "@/components/library/library-view";
import { oneString } from "@/lib/reader-format";

export const metadata: Metadata = { title: "Archive" };
export const dynamic = "force-dynamic";

export default async function ArchivePage({ searchParams }: { searchParams: Promise<{ cursor?: string | string[] }> }) {
  const cursor = oneString((await searchParams).cursor);
  return LibraryView({
    section: "Archive",
    title: "Archive",
    description: "Links you set aside. They stay searchable.",
    view: "archive",
    cursor,
    empty: "No archived links.",
    morePath: "/archive",
  });
}
