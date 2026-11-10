import type { Metadata } from "next";
import { CopyBookmarklet } from "@/components/library/copy-bookmarklet";
import { PageIntro, Panel } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { bookmarkletHref } from "@/lib/reader-format";

export const metadata: Metadata = { title: "Bookmarklet" };
export const dynamic = "force-dynamic";

const steps = {
  ios: [
    "Open this page in Safari.",
    "Tap Share, then Add Bookmark, and save it in Favorites.",
    "Open Bookmarks, then Favorites, then Edit.",
    "Open the new bookmark and replace its address with the bookmarklet above.",
    "Open a page you want to keep and tap that favorite. Press Save on the next screen.",
  ],
  android: [
    "Open this page in Chrome.",
    "Tap the menu, then the star, and bookmark this page.",
    "Tap the menu, then Bookmarks, and edit that bookmark.",
    "Replace the URL with the bookmarklet above and save.",
    "Open a page you want to keep, open the bookmark, and press Save.",
  ],
  desktop: [
    "Drag the Read Later button to the bookmarks bar, or copy the bookmarklet into a new bookmark.",
    "Open a page you want to keep and use that bookmark.",
    "Press Save. The link is not stored until you do.",
  ],
};

export default async function SettingsPage() {
  await requireUserOrRedirect("/settings");
  const href = bookmarkletHref(env().APP_URL);

  return (
    <>
      <PageIntro
        section="Settings"
        title="Bookmarklet"
        description="Save the page you're on. It opens here and waits for Save, so opening it never stores a link by itself."
      />
      <Panel title="Install">
        {href ? (
          <CopyBookmarklet value={href} />
        ) : (
          <p role="alert" className="text-sm font-medium text-danger">
            The app URL is not set up for a bookmarklet.
          </p>
        )}
      </Panel>
      <Panel title="iPhone and iPad">
        <Steps items={steps.ios} />
      </Panel>
      <Panel title="Android">
        <Steps items={steps.android} />
      </Panel>
      <Panel title="Computer">
        <Steps items={steps.desktop} />
      </Panel>
    </>
  );
}

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="list-decimal space-y-2 pl-5">
      {items.map((step) => (
        <li key={step} className="break-words">
          {step}
        </li>
      ))}
    </ol>
  );
}
