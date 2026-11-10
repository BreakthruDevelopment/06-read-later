import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { loadDemoWorkspace } from "@/lib/demo-workspace";
import { errorResponse, readJson } from "@/lib/http";
import { scheduleKick } from "@/lib/jobs/schedule";
import { LIMITS } from "@/lib/limits";

export const dynamic = "force-dynamic";

/** POST /api/admin/demo — copy bundled articles into the admin's own library. No network. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("admin");
    await readJson(request, LIMITS.jsonBodyBytes);
    const result = await loadDemoWorkspace(user);
    scheduleKick(); // the bundled articles are summarized by the job worker, offline in demo mode
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
