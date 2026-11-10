import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { listTags } from "@/lib/links";

export const dynamic = "force-dynamic";

/** GET /api/tags — the caller's tags and how many links use each. */
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ tags: await listTags(user) });
  } catch (err) {
    return errorResponse(err);
  }
}
