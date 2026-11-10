"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { regenerateSummaryAction } from "@/app/links/actions";
import { DemoBadge } from "@/components/ui";
import { buttonSecondary } from "@/components/ui/styles";
import { SUMMARY_FAILED, failLabel, isUnfinished, type LinkStatus } from "@/lib/reader-format";

export type SummaryCardData = {
  mode: "live" | "demo" | "skipped" | "pending";
  summary: string | null;
  keyPoints: string[];
  lowQuality: boolean;
  regenerationsLeft: number;
};

/**
 * The summary for a link. Everything from the model is rendered as React text: never as HTML or Markdown, and
 * never turned into links.
 */
export function SummaryCard({
  id,
  status,
  failCode,
  summary,
}: {
  id: string;
  status: LinkStatus;
  failCode: string | null;
  summary: SummaryCardData | null;
}) {
  if (status === "failed") {
    return (
      <p role="alert" className="text-sm font-medium text-danger">
        {failLabel(failCode) ?? "No summary, because the page didn't load."}
      </p>
    );
  }
  if (isUnfinished(status)) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted" aria-live="polite">
          Summary is on the way. This updates on its own.
        </p>
        {summary && <RegenerationsLeft left={summary.regenerationsLeft} />}
      </div>
    );
  }

  const left = summary?.regenerationsLeft ?? 3;
  const failed = failCode === SUMMARY_FAILED || summary?.mode === "pending";
  if (failed) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm font-medium text-danger">
          Summary unavailable
        </p>
        <p className="text-sm text-muted">The article is still readable above.</p>
        <RegenerateControl id={id} left={left} />
      </div>
    );
  }
  if (!summary || summary.mode === "skipped" || summary.summary === null) {
    return <p className="text-sm text-muted">No summary for this page: it has too little text.</p>;
  }

  return (
    <div className="max-w-[68ch] space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">AI summary of the page&apos;s content</h3>
        {summary.mode === "demo" && <DemoBadge label="demo" />}
      </div>
      {summary.lowQuality && (
        <p role="alert" className="text-sm font-medium text-danger">
          This page may be a paywall or error page
        </p>
      )}
      <p className="break-words whitespace-pre-wrap">{summary.summary}</p>
      {summary.keyPoints.length > 0 && (
        <ul className="list-disc space-y-1 pl-5">
          {summary.keyPoints.map((point, index) => (
            <li key={index} className="break-words">
              {point}
            </li>
          ))}
        </ul>
      )}
      <RegenerateControl id={id} left={left} />
    </div>
  );
}

function RegenerationsLeft({ left }: { left: number }) {
  return (
    <p className="text-sm text-muted">
      {left === 1 ? "1 regeneration left" : `${left} regenerations left`}
    </p>
  );
}

function RegenerateControl({ id, left }: { id: string; left: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function regenerate() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await regenerateSummaryAction(id);
        // 409 (already being made, or no text) and 429 (limit reached) come back as the message to show.
        if (result.error) setError(result.error);
      } catch {
        setError("The summary couldn't be requested. Try again.");
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button type="button" onClick={regenerate} disabled={pending || left < 1} className={buttonSecondary}>
        {pending ? "Requesting…" : "Regenerate summary"}
      </button>
      <RegenerationsLeft left={left} />
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
