import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LibraryView } from "@/components/library/library-view";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { oneString } from "@/lib/reader-format";

const TAG_NAME = /^[a-z0-9][a-z0-9-]{1,23}$/;

export const metadata: Metadata = { title: "Tag" };
export const dynamic = "force-dynamic";

export default async function TagPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ cursor?: string | string[] }>;
}) {
  await requireUserOrRedirect("/tags");
  let name = "";
  try {
    name = decodeURIComponent((await params).name);
  } catch {
    name = "";
  }
  if (!TAG_NAME.test(name)) notFound();
  const cursor = oneString((await searchParams).cursor);
  return LibraryView({
    section: "Tags",
    title: name,
    description: "Links with this tag.",
    view: "all",
    tag: name,
    cursor,
    empty: "No links with this tag.",
    morePath: `/tags/${name}`,
  });
}
