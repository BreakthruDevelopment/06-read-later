import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

/** How long a claim keeps a host if the process dies before releasing it. Matches the job lease. */
const LEASE_SECONDS = 60;
/** Minimum gap between two fetches of one host, applied when the in-flight fetch finishes. */
const GAP_SECONDS = 2;

/** A busy host asks the job to wait this long without using an attempt. */
export const HOST_BUSY_DEFER_MS = 5_000;

/**
 * Take the host if nobody holds it and its gap has passed. One statement, so two jobs can't both win.
 * Returns the lease token the caller must pass to `releaseHost`, or null when the host is busy.
 * A lease whose time has passed can be taken again (the previous worker was killed).
 */
export async function claimHost(host: string): Promise<string | null> {
  const rows = await db().execute<{ lease_epoch: string }>(sql`
    insert into fetch_host (host, next_allowed_at, in_flight)
    values (${host}, now() + make_interval(secs => ${LEASE_SECONDS}), true)
    on conflict (host) do update
      set in_flight = true,
          next_allowed_at = now() + make_interval(secs => ${LEASE_SECONDS})
      where fetch_host.next_allowed_at <= now()
    returning extract(epoch from next_allowed_at)::text as lease_epoch
  `);
  return rows[0]?.lease_epoch ?? null;
}

/**
 * Free the host and start the spacing gap. The lease token must be the one `claimHost` returned, so a slow
 * worker whose lease was already taken cannot clear the new owner's claim.
 */
export async function releaseHost(host: string, leaseEpoch: string): Promise<void> {
  await db().execute(sql`
    update fetch_host
    set in_flight = false,
        next_allowed_at = now() + make_interval(secs => ${GAP_SECONDS})
    where host = ${host}
      and extract(epoch from next_allowed_at)::text = ${leaseEpoch}
  `);
}
