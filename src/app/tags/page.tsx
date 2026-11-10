import type { Metadata } from "next";
import Link from "next/link";
import { ZodError } from "zod";
import { PageIntro, Panel } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { HttpError } from "@/lib/errors";
import { listTags } from "@/lib/links";

export const metadata: Metadata = { title: "Tags" };
export const dynamic = "force-dynamic";

export default async function TagsPage() {
  const user = await requireUserOrRedirect("/tags");
  let tags: Awaited<ReturnType<typeof listTags>> = [];
  let error: string | null = null;
  try {
    tags = await listTags(user);
  } catch (err) {
    if (err instanceof ZodError) error = err.issues[0]?.message ?? "Invalid input";
    else if (err instanceof HttpError) error = err.message;
    else throw err;
  }

  return (
    <>
      <PageIntro section="Tags" title="Tags" description="Your tags, and how many links use each one." />
      <Panel title="Your tags" count={error ? undefined : tags.length}>
        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : tags.length === 0 ? (
          <p className="text-sm text-muted">No tags yet. Add some from a saved page.</p>
        ) : (
          <ul className="divide-y divide-border">
            {tags.map((tag) => (
              <li key={tag.id}>
                <Link href={`/tags/${tag.name}`} className="flex min-h-11 items-center justify-between gap-4 py-2">
                  <span className="font-semibold break-words">{tag.name}</span>
                  <span className="text-sm text-muted">{tag.count}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
