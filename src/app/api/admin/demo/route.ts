import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { loadDemoWorkspace } from "@/lib/demo-workspace";
import { errorResponse, readJson } from "@/lib/http";
import { LIMITS } from "@/lib/limits";

export const dynamic = "force-dynamic";

/** POST /api/admin/demo — copy bundled articles into the admin's own library. No network. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("admin");
    await readJson(request, LIMITS.jsonBodyBytes);
    return Response.json(await loadDemoWorkspace(user));
  } catch (err) {
    return errorResponse(err);
  }
}
