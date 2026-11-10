"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  STATUS_POLL_BUDGET_MS,
  STATUS_POLL_MS,
  failLabel,
  isLinkStatus,
  isUnfinished,
  statusPresentation,
  type LinkStatus,
} from "@/lib/reader-format";

/**
 * Status chip. While the link is unfinished, polls GET /api/links/:id every 3 seconds
 * for at most 2 minutes, then tells the reader it finishes on the next visit.
 */
export function StatusChip({
  id,
  initialStatus,
  initialFailCode,
}: {
  id: string;
  initialStatus: LinkStatus;
  initialFailCode: string | null;
}) {
  const router = useRouter();
  const [tracked, setTracked] = useState({ status: initialStatus, failCode: initialFailCode });
  const [override, setOverride] = useState<{ status: LinkStatus; failCode: string | null } | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  if (tracked.status !== initialStatus || tracked.failCode !== initialFailCode) {
    setTracked({ status: initialStatus, failCode: initialFailCode });
    setOverride(null);
    setGaveUp(false);
  }

  const status = override?.status ?? initialStatus;
  const failCode = override?.failCode ?? initialFailCode;
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (!isUnfinished(initialStatus)) return;
    const started = Date.now();
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (Date.now() - started > STATUS_POLL_BUDGET_MS) {
        stopped = true;
        setGaveUp(true);
        return;
      }
      try {
        const res = await fetch(`/api/links/${id}`, { headers: { accept: "application/json" } });
        if (res.status === 404) {
          stopped = true;
          return;
        }
        if (!res.ok) return;
        const body = (await res.json()) as { link?: { status?: unknown; failCode?: string | null } };
        const next = body.link?.status;
        if (!isLinkStatus(next) || next === statusRef.current) return;
        setOverride({ status: next, failCode: body.link?.failCode ?? null });
        if (next === "extracted" || next === "summarizing" || next === "ready" || next === "failed") router.refresh();
        if (!isUnfinished(next)) stopped = true;
      } catch {
        // The next tick tries again. The last chip stays visible.
      }
    };
    const timer = setInterval(() => void tick(), STATUS_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [id, initialStatus, router]);

  const chip = statusPresentation(status, gaveUp);
  const failure = status === "failed" ? failLabel(failCode) : null;

  return (
    <span className="inline-flex max-w-full flex-col items-start gap-1" aria-live="polite">
      <StatusBadge status={chip.tone} label={chip.label} />
      {failure && <span className="text-sm text-danger">{failure}</span>}
      {isUnfinished(status) && !gaveUp && <span className="sr-only">Checking status</span>}
    </span>
  );
}
