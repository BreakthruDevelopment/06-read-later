import { redirect } from "next/navigation";
import { requireUserOrRedirect } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** The template path. Signed-out visitors still go to sign-in; everyone else goes to the inbox. */
export default async function DashboardPage() {
  await requireUserOrRedirect();
  redirect("/inbox");
}
