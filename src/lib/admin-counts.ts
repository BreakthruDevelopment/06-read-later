import "server-only";
import { count, desc, eq } from "drizzle-orm";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import type { LinkStatus } from "@/lib/db/schema";
import { LINK_STATUSES } from "@/lib/db/schema";
import { queueStats } from "@/lib/jobs/queue";
import { LIMITS } from "@/lib/limits";
import { dailyCount } from "@/lib/usage";

const { user, link } = schema;

export type AdminCounts = {
  users: number;
  linksByStatus: Record<LinkStatus, number>;
  queue: { queued: number; oldestSeconds: number };
  fetchFailuresByCode: Record<string, number>;
  ai: { summariesToday: number; summaryDailyCap: number; fetchesToday: number; fetchDailyCap: number };
};

/** Accounts for the admin page. Names and emails only: no sessions, tokens, or link contents. */
export async function listUsers(actor: Actor): Promise<{ id: string; name: string; email: string; role: string; createdAt: Date }[]> {
  assertCan(actor, "read");
  return db()
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    })
    .from(user)
    .orderBy(desc(user.createdAt))
    .limit(100);
}

/** Numbers only. Never titles, URLs, or tags. */
export async function adminCounts(actor: Actor): Promise<AdminCounts> {
  assertCan(actor, "read");
  const database = db();
  const [{ users }] = await database.select({ users: count() }).from(user);
  const statusRows = await database.select({ status: link.status, n: count() }).from(link).groupBy(link.status);
  const linksByStatus = Object.fromEntries(LINK_STATUSES.map((status) => [status, 0])) as Record<LinkStatus, number>;
  for (const row of statusRows) linksByStatus[row.status] = Number(row.n);
  const failRows = await database
    .select({ code: link.failCode, n: count() })
    .from(link)
    .where(eq(link.status, "failed"))
    .groupBy(link.failCode);
  const fetchFailuresByCode: Record<string, number> = {};
  for (const row of failRows) fetchFailuresByCode[row.code ?? "unknown"] = Number(row.n);
  const queue = await queueStats(database);
  return {
    users: Number(users),
    linksByStatus,
    queue: { queued: queue.queued, oldestSeconds: queue.oldestQueuedSeconds },
    fetchFailuresByCode,
    ai: {
      summariesToday: await dailyCount("summarize"),
      summaryDailyCap: LIMITS.summaryDaily,
      fetchesToday: await dailyCount("fetch"),
      fetchDailyCap: LIMITS.fetchDaily,
    },
  };
}
