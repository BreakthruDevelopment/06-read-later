import "server-only";
import { after } from "next/server";
import { kick } from "./worker";

/** Run due jobs once the response has been sent. */
export function scheduleKick(): void {
  after(() => kick());
}

/**
 * Start the job that was just enqueued, once the response has been sent: a fetch for a queued link, or a summary for a
 * bundled fixture (stored `extracted`). Duplicates do not enqueue, so they do not kick.
 */
export function scheduleFetchKick(created: boolean, status: string): void {
  if (!created || (status !== "queued" && status !== "extracted")) return;
  scheduleKick();
}
