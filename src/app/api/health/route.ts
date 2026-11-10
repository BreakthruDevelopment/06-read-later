import { pingDb } from "@/lib/db";
import { migrationState } from "@/lib/db/migrate-on-start";
import { log } from "@/lib/log";
import { safeErrorFields } from "@/lib/safe-error";

export const dynamic = "force-dynamic";

/**
 * Liveness and readiness in one: every cloud's health check and the Build Tracker
 * call this. Returns 503 when the database is unreachable, or when startup
 * migrations haven't succeeded yet (they retry in the background).
 * `queue` is counts only: how many jobs are queued, and how long the oldest due one has waited.
 */
export async function GET() {
  const dbOk = await pingDb();
  const migrations = migrationState();
  const migrationsOk = migrations === undefined || migrations === "ok" || migrations === "skipped";
  const queue = dbOk ? await queueCheck() : undefined;
  const ok = dbOk && migrationsOk;
  const body = {
    status: ok ? "ok" : "degraded",
    app: process.env.APP_NAME ?? "30-apps-template",
    version: process.env.APP_VERSION ?? "dev",
    cloud: process.env.CLOUD ?? "local",
    checks: {
      database: dbOk ? "ok" : "unreachable",
      ...(migrations && migrations !== "skipped" ? { migrations: migrationsOk ? "ok" : migrations } : {}),
    },
    ...(queue ? { queue } : {}),
    time: new Date().toISOString(),
  };
  return Response.json(body, { status: ok ? 200 : 503 });
}

async function queueCheck(): Promise<{ queued: number; oldestSeconds: number } | undefined> {
  try {
    const { db } = await import("@/lib/db");
    if (typeof db !== "function") return undefined;
    const { queueStats } = await import("@/lib/jobs/queue");
    const stats = await queueStats(db());
    return { queued: stats.queued, oldestSeconds: stats.oldestQueuedSeconds };
  } catch (err) {
    log.warn("health.queue_failed", safeErrorFields(err));
    return undefined;
  }
}
