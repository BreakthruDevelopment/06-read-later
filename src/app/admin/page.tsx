import type { Metadata } from "next";
import { type Column, DataList, PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { adminCounts, listUsers } from "@/lib/admin-counts";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { LIMITS } from "@/lib/limits";
import { DemoButton } from "./demo-button";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const admin = await requireRoleOrRedirect("admin");
  const counts = await adminCounts(admin);
  const users = await listUsers(admin);

  type Row = (typeof users)[number];
  const columns: Column<Row>[] = [
    { key: "name", header: "Name", primary: true, cell: (u) => u.name },
    { key: "email", header: "Email", className: "break-all", cell: (u) => <span className="break-all">{u.email}</span> },
    {
      key: "role",
      header: "Role",
      cell: (u) => (u.role === "admin" ? <span className="inline-flex rounded-md bg-accent-soft px-2 py-0.5 text-sm font-medium text-accent">Admin</span> : "User"),
    },
    {
      key: "joined",
      header: "Joined",
      className: "whitespace-nowrap",
      cell: (u) => u.createdAt.toISOString().slice(0, 10),
    },
  ];

  return (
    <>
      <PageIntro section="Admin" title="Counts" description="Totals only. Other people's links, titles, and tags stay private." />
      <StatGrid>
        <StatTile value={counts.users} label="Users" tone="accent" />
        <StatTile value={counts.queue.queued} label="Queued jobs" />
        <StatTile value={counts.queue.oldestSeconds} label="Oldest queued (seconds)" />
        <StatTile value={`${counts.ai.fetchesToday}/${counts.ai.fetchDailyCap}`} label="Fetches today" />
        <StatTile value={`${counts.ai.summariesToday}/${counts.ai.summaryDailyCap}`} label="Summaries today" />
      </StatGrid>
      <Panel title="Caps">
        <ul className="space-y-1 text-sm">
          <li>
            {LIMITS.savesPerHour} saves an hour, {LIMITS.savesPerDay} a day, {LIMITS.linksPerUser} links per account
          </li>
          <li>
            {LIMITS.queuedPerUser} queued fetches per account, {LIMITS.queuedApp} app-wide
          </li>
          <li>{LIMITS.retriesPerLinkPerDay} retries per link a day</li>
        </ul>
      </Panel>
      <Panel title="Links by status">
        <ul className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
          {Object.entries(counts.linksByStatus).map(([status, n]) => (
            <li key={status}>
              <span className="font-semibold">{n}</span> <span className="text-muted">{status}</span>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Fetch failures by code">
        {Object.keys(counts.fetchFailuresByCode).length === 0 ? (
          <p className="text-sm text-muted">None.</p>
        ) : (
          <ul className="text-sm">
            {Object.entries(counts.fetchFailuresByCode).map(([code, n]) => (
              <li key={code}>
                <span className="font-semibold">{n}</span> <span className="text-muted">{code}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Demo workspace">
        <DemoButton />
      </Panel>
      <Panel title="All users" count={users.length}>
        <DataList caption="Users" rows={users} rowKey={(u) => u.id} columns={columns} empty="No users yet." />
      </Panel>
    </>
  );
}
