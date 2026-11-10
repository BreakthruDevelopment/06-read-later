"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z, ZodError } from "zod";
import { requireUser } from "@/lib/auth/session";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { requireSameOrigin } from "@/lib/csrf";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/errors";
import { LIMITS } from "@/lib/limits";
import { deleteLink, patchLink, retryLink, saveLink } from "@/lib/links";
import { invalidTag, parseTagList } from "@/lib/reader-format";

export type LinkActionState = { error?: string; ok?: boolean; id?: string; created?: boolean };

async function sameOrigin(): Promise<void> {
  requireSameOrigin(new Request(env().APP_URL, { headers: await headers() }));
}

function failure(err: unknown): LinkActionState {
  if (err instanceof ZodError) return { error: err.issues[0]?.message ?? "Invalid input" };
  if (err instanceof HttpError || err instanceof ForbiddenError || err instanceof UnauthorizedError) return { error: err.message };
  throw err;
}

function refreshLibrary(): void {
  revalidatePath("/", "layout");
}

export async function saveLinkAction(_prev: LinkActionState, form: FormData): Promise<LinkActionState> {
  try {
    await sameOrigin();
    const user = await requireUser();
    const result = await saveLink(user, { url: form.get("url") });
    refreshLibrary();
    return { ok: true, id: result.link.id, created: result.created };
  } catch (err) {
    return failure(err);
  }
}

const flagInput = z.object({
  id: z.uuid(),
  field: z.enum(["archived", "favorite", "read"]),
  value: z.enum(["true", "false"]),
});

export async function flagLinkAction(_prev: LinkActionState, form: FormData): Promise<LinkActionState> {
  try {
    await sameOrigin();
    const user = await requireUser();
    const data = flagInput.parse({ id: form.get("id"), field: form.get("field"), value: form.get("value") });
    const on = data.value === "true";
    await patchLink(user, data.id, { [data.field]: on });
    refreshLibrary();
    return { ok: true, id: data.id };
  } catch (err) {
    return failure(err);
  }
}

export async function tagsLinkAction(_prev: LinkActionState, form: FormData): Promise<LinkActionState> {
  try {
    await sameOrigin();
    const user = await requireUser();
    const data = z.object({ id: z.uuid(), tags: z.string().max(400) }).parse({ id: form.get("id"), tags: form.get("tags") ?? "" });
    const names = parseTagList(data.tags);
    if (names.length > LIMITS.tagsPerPatch) return { error: `You can set up to ${LIMITS.tagsPerPatch} tags at a time.` };
    if (names.some(invalidTag)) return { error: "Tags are short lowercase slugs, such as postgres or small-teams." };
    await patchLink(user, data.id, { tags: names });
    refreshLibrary();
    return { ok: true, id: data.id };
  } catch (err) {
    return failure(err);
  }
}

export async function retryLinkAction(_prev: LinkActionState, form: FormData): Promise<LinkActionState> {
  try {
    await sameOrigin();
    const user = await requireUser();
    const id = z.uuid().parse(form.get("id"));
    await retryLink(user, id);
    refreshLibrary();
    return { ok: true, id };
  } catch (err) {
    return failure(err);
  }
}

export async function deleteLinkAction(_prev: LinkActionState, form: FormData): Promise<LinkActionState> {
  try {
    await sameOrigin();
    const user = await requireUser();
    const id = z.uuid().parse(form.get("id"));
    await deleteLink(user, id);
    refreshLibrary();
  } catch (err) {
    return failure(err);
  }
  redirect("/inbox");
}
