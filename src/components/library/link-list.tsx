import Link from "next/link";
import { type Column, DataList, DemoBadge } from "@/components/ui";
import type { LinkView } from "@/lib/links";
import { fixtureByUrl } from "@/lib/links/fixtures";
import { readingLabel } from "@/lib/reader-format";
import { AiTagBadge } from "./ai-tag-badge";
import { RetryButton } from "./link-controls";
import { StatusChip } from "./status-chip";

function titleOf(link: LinkView): string {
  return link.title?.trim() || link.url;
}

export function LinkList({ links, empty }: { links: LinkView[]; empty: string }) {
  const columns: Column<LinkView>[] = [
    {
      key: "title",
      header: "Title",
      primary: true,
      cell: (link) => (
        <span className="inline-flex max-w-full flex-wrap items-center gap-2">
          <Link href={`/links/${link.id}`} className="font-semibold break-words text-accent hover:underline">
            {titleOf(link)}
          </Link>
          {link.favorite && <span className="text-sm text-muted">Favorite</span>}
          {fixtureByUrl.has(link.url) && <DemoBadge />}
        </span>
      ),
    },
    {
      key: "site",
      header: "Site",
      className: "break-all",
      cell: (link) => link.siteName || link.host,
    },
    {
      key: "time",
      header: "Time",
      className: "whitespace-nowrap",
      cell: (link) => readingLabel(link.wordCount) ?? "",
    },
    {
      key: "tags",
      header: "Tags",
      cell: (link) =>
        link.tags.length === 0 ? (
          ""
        ) : (
          <span className="inline-flex flex-wrap justify-end gap-x-2 gap-y-1 sm:justify-start">
            {link.tags.map((tag) => (
              <span key={tag.id} className="inline-flex items-center gap-1">
                <Link href={`/tags/${tag.name}`} className="text-accent hover:underline">
                  {tag.name}
                </Link>
                {tag.source === "ai" && <AiTagBadge />}
              </span>
            ))}
          </span>
        ),
    },
    {
      key: "status",
      header: "Status",
      cell: (link) => (
        <span className="inline-flex max-w-full flex-col items-end gap-2 sm:items-start">
          <StatusChip id={link.id} initialStatus={link.status} initialFailCode={link.failCode} />
          {link.status === "failed" && <RetryButton id={link.id} />}
        </span>
      ),
    },
  ];

  return <DataList caption="Saved links" rows={links} rowKey={(link) => link.id} columns={columns} empty={empty} />;
}
