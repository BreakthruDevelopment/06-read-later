import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { scheduleFetchKick } from "@/lib/jobs/schedule";
import { LIMITS } from "@/lib/limits";
import { listLinks, saveLink } from "@/lib/links";

export const dynamic = "force-dynamic";

/** GET /api/links — own links. `q` is ranked search. `view` is all, inbox, archive, or favorites. */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const url = new URL(request.url);
    const tag = url.searchParams.get("tag");
    const q = url.searchParams.get("q");
    const result = await listLinks(user, {
      view: url.searchParams.get("view") ?? undefined,
      tag: tag || undefined,
      q: q ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/links — body `{url}`. 202 when created, 200 when that URL was already saved. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const body = await readJson(request, LIMITS.jsonBodyBytes);
    const result = await saveLink(user, body);
    scheduleFetchKick(result.created, result.link.status);
    return Response.json({ id: result.link.id, status: result.link.status }, { status: result.created ? 202 : 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
