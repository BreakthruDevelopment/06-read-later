/**
 * The one place an app names itself. The header, the page title and the sign-in
 * page all read APP_TITLE. Set APP_NAME in the environment, or change the default
 * below when an app is created from the template.
 */
export const APP_TITLE = process.env.APP_NAME || "Read Later";

export const APP_DESCRIPTION = "Save a link, then read a clean copy later. Search and tags stay on your account.";

export const PARENT_SITE = { href: "https://breakthruventures.ai", label: "Explore breakthruventures.ai" };

/** Header navigation. `adminOnly` links are hidden for other users; pages still enforce the role. */
export const NAV_LINKS: { href: string; label: string; adminOnly?: boolean }[] = [
  { href: "/inbox", label: "Inbox" },
  { href: "/archive", label: "Archive" },
  { href: "/tags", label: "Tags" },
  { href: "/search", label: "Search" },
  { href: "/admin", label: "Admin", adminOnly: true },
];
