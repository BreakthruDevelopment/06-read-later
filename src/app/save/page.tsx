import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SaveLinkForm } from "@/components/library/save-link-form";
import { PageIntro, Panel } from "@/components/ui";
import { getCurrentUser, requireUserOrRedirect } from "@/lib/auth/session";
import { oneString, safeNext } from "@/lib/reader-format";

export const metadata: Metadata = { title: "Save" };
export const dynamic = "force-dynamic";

/** Bookmarklet target. GET only shows the URL; the link is stored when the form is posted. */
export default async function SavePage({ searchParams }: { searchParams: Promise<{ url?: string | string[] }> }) {
  const raw = oneString((await searchParams).url) ?? "";
  const user = await getCurrentUser();
  if (!user) {
    const next = raw.length > 0 && raw.length <= 2048 ? `/save?url=${encodeURIComponent(raw)}` : "/save";
    redirect(`/sign-in?next=${encodeURIComponent(safeNext(next))}`);
  }
  await requireUserOrRedirect();
  const tooLong = raw.length > 2048;

  return (
    <>
      <PageIntro section="Save" title="Save a link" description="Nothing is saved until you press Save." />
      <Panel title="Link">
        {tooLong ? (
          <p role="alert" className="text-sm font-medium text-danger">
            That URL is too long.
          </p>
        ) : (
          <SaveLinkForm defaultUrl={raw} />
        )}
      </Panel>
    </>
  );
}
