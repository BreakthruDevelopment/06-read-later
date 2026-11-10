import "server-only";
import { after } from "next/server";
import { kick } from "./worker";

/**
 * Start the fetch that was just enqueued, once the response has been sent.
 * Fixtures are stored ready and duplicates do not enqueue, so neither kicks.
 */
export function scheduleFetchKick(created: boolean, status: string): void {
  if (!created || status !== "queued") return;
  after(() => kick());
}
