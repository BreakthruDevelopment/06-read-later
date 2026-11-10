import { fetchLinkHandler, giveUpFetch } from "@/lib/fetch/run";
import type { JobGiveUp, JobHandlers } from "./worker";

/**
 * One entry per job `kind`. `instrumentation.ts` hands this map to `startWorker`.
 * `summarize` is registered by the summary issue; until then those rows stay queued.
 */
export const handlers: JobHandlers = {
  fetch: fetchLinkHandler,
};

/** Optional per-kind hook for a job that failed for good; see `JobGiveUp`. */
export const onGiveUp: Record<string, JobGiveUp> = {
  fetch: giveUpFetch,
};
