import { fetchLinkHandler, giveUpFetch } from "@/lib/fetch/run";
import { giveUpSummarize, summarizeLinkHandler } from "@/lib/summaries/run";
import type { JobGiveUp, JobHandlers } from "./worker";

/**
 * One entry per job `kind`. `instrumentation.ts` hands this map to `startWorker`.
 */
export const handlers: JobHandlers = {
  fetch: fetchLinkHandler,
  summarize: summarizeLinkHandler,
};

/** Optional per-kind hook for a job that failed for good; see `JobGiveUp`. */
export const onGiveUp: Record<string, JobGiveUp> = {
  fetch: giveUpFetch,
  summarize: giveUpSummarize,
};
