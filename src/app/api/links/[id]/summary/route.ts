import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readBodyCapped } from "@/lib/http";
import { scheduleKick } from "@/lib/jobs/schedule";
import { LIMITS } from "@/lib/limits";
import { regenerateSummary } from "@/lib/summaries/run";

export const dynamic = "force-dynamic";

/**
 * POST /api/links/:id/summary — owner only (anyone else, admin included, gets 404). Body is empty or `{}`.
 * 202 `{id, status: "summarizing", regenerationsLeft}`; 409 when a summary is already being made or the link has no
 * text; 429 after 3 regenerations of this link or 30 summaries this hour.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { id } = await ctx.params;
    await readBodyCapped(request, LIMITS.jsonBodyBytes); // no fields yet; the cap still applies
    const result = await regenerateSummary(user, id);
    scheduleKick();
    return Response.json(result, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
