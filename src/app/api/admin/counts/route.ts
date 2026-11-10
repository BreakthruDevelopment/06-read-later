import { requireRole } from "@/lib/auth/session";
import { adminCounts } from "@/lib/admin-counts";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/counts — counts only. No URLs, titles, or tags. */
export async function GET() {
  try {
    const user = await requireRole("admin");
    return Response.json(await adminCounts(user));
  } catch (err) {
    return errorResponse(err);
  }
}
