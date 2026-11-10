import Link from "next/link";
import { PageIntro, Panel, buttonPrimary, buttonSecondary } from "@/components/ui";

const features = [
  {
    title: "Save in one step",
    body: "Paste a URL, use the bookmarklet, or open a /save link. Nothing is stored until you press Save.",
  },
  {
    title: "Read the text",
    body: "The reader shows the article as plain paragraphs, with a short summary and tags when they're ready.",
  },
  {
    title: "Find it later",
    body: "Search your own library, filter by tag, and set links aside in the archive or favorites.",
  },
  {
    title: "It finishes in the background",
    body: "Saving returns at once. Fetching and the summary continue while you watch, or the next time you open the app.",
  },
];

export default function Home() {
  return (
    <>
      <PageIntro
        section="Read Later"
        title="Save it now. Read it cleanly later."
        description="A pocket for links: a clean reader, search, and tags, without filing anything by hand."
        actions={
          <>
            <Link href="/sign-in" className={buttonPrimary}>
              Get started
            </Link>
            <Link href="/settings" className={buttonSecondary}>
              Bookmarklet
            </Link>
          </>
        }
      />
      <div className="grid gap-x-4 sm:grid-cols-2">
        {features.map((feature) => (
          <Panel key={feature.title} title={feature.title}>
            <p className="text-muted">{feature.body}</p>
          </Panel>
        ))}
      </div>
    </>
  );
}
