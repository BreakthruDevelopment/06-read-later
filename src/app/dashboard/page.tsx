import type { Metadata } from "next";
import { PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { listLinks } from "@/lib/links";
import { SaveLinkForm } from "./save-form";

export const metadata: Metadata = { title: "Library" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireUserOrRedirect();
  const { links } = await listLinks(user, { view: "all", limit: 50 });

  return (
    <>
      <PageIntro section="Library" title={`Hi, ${user.name}`} description={`Signed in as ${user.email}. Saved links stay on this account.`} />
      <StatGrid>
        <StatTile value={links.length} label="Links on this page" tone="accent" />
      </StatGrid>
      <Panel title="Save a link">
        <SaveLinkForm />
      </Panel>
      <Panel title="Your links" count={links.length}>
        {links.length === 0 ? (
          <p className="text-sm text-muted">Nothing saved yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {links.map((item) => (
              <li key={item.id} className="flex flex-col gap-1 py-3">
                <span className="font-semibold break-words">{item.title ?? item.url}</span>
                <span className="text-sm text-muted">
                  {item.host} · {item.status}
                  {item.tags.length > 0 ? ` · ${item.tags.map((tag) => tag.name).join(", ")}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
