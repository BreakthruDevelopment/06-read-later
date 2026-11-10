import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { LIMITS } from "@/lib/limits";
import { deleteLink, getLink, patchLink } from "@/lib/links";

export const dynamic = "force-dynamic";

/** GET /api/links/:id — the owner only. Anyone else, including an admin, gets 404. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    return Response.json({ link: await getLink(user, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/links/:id — body `{archived?, favorite?, read?, tags?}`. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await readJson(request, LIMITS.jsonBodyBytes);
    return Response.json({ link: await patchLink(user, id, body) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/links/:id — the owner only. */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { id } = await ctx.params;
    await deleteLink(user, id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
