import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { nudge } from "@/lib/jobs/worker";
import { safeNext } from "@/lib/reader-format";
import { auth } from "./index";
import { type Actor, type Role, ForbiddenError, UnauthorizedError, toRole } from "./rbac";

export type CurrentUser = Actor & { name: string; email: string };

/**
 * The data access layer's single entry point for "who is this?".
 * Returns a narrow user object, never the raw session.
 * Wrapped in React cache(), so the shell and the page share one lookup per request.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const result = await auth().api.getSession({ headers: await headers() });
  if (!result?.user) return null;
  const u = result.user as typeof result.user & { role?: string | null; banned?: boolean | null };
  if (u.banned) return null;
  // Debounced (once per 10s per process) so due jobs run while anyone is signed in.
  nudge();
  return { id: u.id, name: u.name, email: u.email, role: toRole(u.role) };
});

/** For pages: send signed-out visitors to the sign-in page, then back to `nextPath` when it is in this app. */
export async function requireUserOrRedirect(nextPath?: string): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    const next = nextPath ? safeNext(nextPath) : "";
    redirect(next && next !== "/inbox" ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in");
  }
  return user;
}

/** For pages: signed-in users without the role go to the inbox. */
export async function requireRoleOrRedirect(role: Role): Promise<CurrentUser> {
  const user = await requireUserOrRedirect();
  if (role === "admin" && user.role !== "admin") redirect("/inbox");
  return user;
}

/** For route handlers and server actions: throw, so the caller maps it to 401/403. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export async function requireRole(role: Role): Promise<CurrentUser> {
  const user = await requireUser();
  if (role === "admin" && user.role !== "admin") throw new ForbiddenError();
  return user;
}
