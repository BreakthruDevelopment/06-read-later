import Link from "next/link";
import type { ReactNode } from "react";
import { ZodError } from "zod";
import { PageIntro, Panel } from "@/components/ui";
import { buttonSecondary } from "@/components/ui/styles";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { HttpError } from "@/lib/errors";
import { listLinks } from "@/lib/links";
import { LinkList } from "./link-list";
import { SaveLinkForm } from "./save-link-form";

function listError(err: unknown): string {
  if (err instanceof ZodError) {
    if (err.issues[0]?.path[0] === "q") return "Search for 200 characters or fewer.";
    return "Those filters aren't valid. Go back and try again.";
  }
  if (err instanceof HttpError) return err.message;
  throw err;
}

export async function LibraryView({
  section,
  title,
  description,
  view,
  tag,
  query,
  cursor,
  save = false,
  empty,
  morePath,
  listTitle = "Links",
  showIntro = true,
  actions,
}: {
  section: string;
  title: string;
  description: string;
  view: "all" | "inbox" | "archive" | "favorites";
  tag?: string;
  query?: string;
  cursor?: string;
  save?: boolean;
  empty: string;
  morePath: string;
  listTitle?: string;
  showIntro?: boolean;
  actions?: ReactNode;
}) {
  const user = await requireUserOrRedirect(morePath);
  let links: Awaited<ReturnType<typeof listLinks>>["links"] = [];
  let nextCursor: string | null = null;
  let error: string | null = null;
  try {
    const page = await listLinks(user, { view, tag, q: query, cursor, limit: 50 });
    links = page.links;
    nextCursor = page.nextCursor;
  } catch (err) {
    error = listError(err);
  }

  const moreHref = nextCursor ? `${morePath}?cursor=${encodeURIComponent(nextCursor)}` : null;

  return (
    <>
      {showIntro && <PageIntro section={section} title={title} description={description} actions={actions} />}
      {save && (
        <Panel title="Save a link">
          <SaveLinkForm />
        </Panel>
      )}
      <Panel title={listTitle} count={error ? undefined : links.length}>
        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : (
          <LinkList links={links} empty={empty} />
        )}
        {moreHref && (
          <div className="mt-4">
            <Link href={moreHref} className={buttonSecondary}>
              More
            </Link>
          </div>
        )}
      </Panel>
    </>
  );
}
