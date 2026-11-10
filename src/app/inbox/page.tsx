import type { Metadata } from "next";
import Link from "next/link";
import { LibraryView } from "@/components/library/library-view";
import { buttonSecondary } from "@/components/ui/styles";
import { oneString } from "@/lib/reader-format";

export const metadata: Metadata = { title: "Inbox" };
export const dynamic = "force-dynamic";

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ cursor?: string | string[] }> }) {
  const cursor = oneString((await searchParams).cursor);
  return LibraryView({
    section: "Inbox",
    title: "Inbox",
    description: "Unread links, newest first. Saving returns at once; fetching finishes in the background.",
    view: "inbox",
    cursor,
    save: true,
    empty: "Nothing unread. Save a link and it will wait here.",
    morePath: "/inbox",
    actions: (
      <>
        <Link href="/favorites" className={buttonSecondary}>
          Favorites
        </Link>
        <Link href="/settings" className={buttonSecondary}>
          Bookmarklet
        </Link>
      </>
    ),
  });
}
