import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DeleteLinkButton, FlagButton, RetryButton, TagEditor } from "@/components/library/link-controls";
import { AiTagBadge } from "@/components/library/ai-tag-badge";
import { StatusChip } from "@/components/library/status-chip";
import { SummaryCard } from "@/components/library/summary-card";
import { DemoBadge, PageIntro, Panel } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { NotFoundError } from "@/lib/errors";
import { getLink, type LinkView } from "@/lib/links";
import { fixtureByUrl } from "@/lib/links/fixtures";
import { failLabel, isUnfinished, readingLabel, type LinkStatus } from "@/lib/reader-format";

export const metadata: Metadata = { title: "Reader" };
export const dynamic = "force-dynamic";

export default async function ReaderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const back = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? `/links/${id}` : undefined;
  const user = await requireUserOrRedirect(back);
  let item: LinkView;
  try {
    item = await getLink(user, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const minutes = readingLabel(item.wordCount);
  const meta = [item.siteName || item.host, item.content?.byline, minutes].filter(Boolean).join(" · ");
  const userTags = item.tags.filter((tag) => tag.source === "user").map((tag) => tag.name);
  const aiTags = item.tags.filter((tag) => tag.source === "ai");

  return (
    <>
      <Link href="/inbox" className="mb-3 inline-flex min-h-11 items-center text-sm font-semibold text-accent">
        Inbox
      </Link>
      <PageIntro
        section="Reader"
        title={item.title?.trim() || item.url}
        description={meta || undefined}
        actions={fixtureByUrl.has(item.url) ? <DemoBadge /> : undefined}
      />
      <div className="mb-6 flex max-w-full flex-wrap items-start gap-3">
        <StatusChip id={item.id} initialStatus={item.status} initialFailCode={item.failCode} />
        {item.status === "failed" && <RetryButton id={item.id} />}
      </div>
      <div className="mb-6 flex flex-wrap gap-3">
        <FlagButton
          id={item.id}
          field="archived"
          value={!item.archivedAt}
          label={item.archivedAt ? "Unarchive" : "Archive"}
          pendingLabel="Saving…"
        />
        <FlagButton
          id={item.id}
          field="favorite"
          value={!item.favorite}
          label={item.favorite ? "Unfavorite" : "Favorite"}
          pendingLabel="Saving…"
        />
        <FlagButton
          id={item.id}
          field="read"
          value={!item.readAt}
          label={item.readAt ? "Mark unread" : "Mark read"}
          pendingLabel="Saving…"
        />
        <DeleteLinkButton id={item.id} />
      </div>
      <Panel title="Article">
        {/* Text paragraphs only. Stored pages are never rendered as HTML. */}
        <Article status={item.status} failCode={item.failCode} paragraphs={item.content?.paragraphs ?? []} />
      </Panel>
      <Panel title="Summary">
        <SummaryCard
          id={item.id}
          status={item.status}
          failCode={item.failCode}
          summary={
            item.summary && {
              mode: item.summary.mode,
              summary: item.summary.summary,
              keyPoints: item.summary.keyPoints,
              lowQuality: item.summary.lowQuality,
              regenerationsLeft: item.summary.regenerationsLeft,
            }
          }
        />
      </Panel>
      <Panel title="Tags">
        {aiTags.length > 0 && (
          <ul className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            {aiTags.map((tag) => (
              <li key={tag.id} className="inline-flex items-center gap-1">
                <Link href={`/tags/${tag.name}`} className="inline-flex min-h-6 items-center font-semibold text-accent hover:underline">
                  {tag.name}
                </Link>
                <AiTagBadge />
              </li>
            ))}
          </ul>
        )}
        <TagEditor id={item.id} tags={userTags.join(" ")} />
      </Panel>
      <Panel title="Original">
        <a href={item.url} rel="noopener noreferrer nofollow" target="_blank" className="inline-block max-w-full break-all text-accent underline">
          {item.url}
        </a>
      </Panel>
    </>
  );
}

function Article({
  status,
  failCode,
  paragraphs,
}: {
  status: LinkStatus;
  failCode: string | null;
  paragraphs: string[];
}) {
  if (paragraphs.length === 0) {
    if (status === "failed") {
      return (
        <p role="alert" className="text-sm font-medium text-danger">
          {failLabel(failCode) ?? "The page didn't load."}
        </p>
      );
    }
    if (isUnfinished(status)) return <p className="text-sm text-muted">Fetching the page. This updates on its own.</p>;
    return <p className="text-sm text-muted">Couldn&apos;t extract readable text.</p>;
  }
  return (
    <div className="max-w-[68ch] font-display text-[18px] leading-relaxed">
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="mb-4 break-words last:mb-0">
          {paragraph}
        </p>
      ))}
    </div>
  );
}
