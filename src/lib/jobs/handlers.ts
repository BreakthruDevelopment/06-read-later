import { fetchLinkHandler } from "@/lib/fetch/run";
import type { JobHandlers } from "./worker";

/**
 * One entry per job `kind`. `instrumentation.ts` hands this map to `startWorker`.
 * `summarize` is registered by the summary issue; until then those rows stay queued.
 */
export const handlers: JobHandlers = {
  fetch: fetchLinkHandler,
};
