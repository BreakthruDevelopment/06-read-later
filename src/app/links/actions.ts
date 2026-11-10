"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { ZodError } from "zod";
import { requireUser } from "@/lib/auth/session";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { requireSameOrigin } from "@/lib/csrf";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/errors";
import { deleteLink, patchLink, saveLink } from "@/lib/links";

export type LinkActionState = { error?: string; ok?: boolean; id?: string };

async function sameOrigin(): Promise<void> {
  requireSameOrigin(new Request(env().APP_URL, { headers: await headers() }));
}

function failure(err: unknown): LinkActionState {
  if (err instanceof ZodError) return { error: err.issues[0]?.message ?? "Invalid input" };
  if (err instanceof HttpError || err instanceof ForbiddenError || err instanceof UnauthorizedError) return { error: err.message };
  throw err;
}

export async function saveLinkAction(_prev: LinkActionState, form: FormData): Promise<LinkActionState> {
  try {
    await sameOrigin();
    const user = await requireUser();
    const result = await saveLink(user, { url: form.get("url") });
    revalidatePath("/dashboard");
    return { ok: true, id: result.link.id };
  } catch (err) {
    return failure(err);
  }
}

export async function patchLinkAction(id: string, input: unknown): Promise<LinkActionState> {
  try {
    await sameOrigin();
    const user = await requireUser();
    await patchLink(user, id, input);
    revalidatePath("/dashboard");
    return { ok: true, id };
  } catch (err) {
    return failure(err);
  }
}

export async function deleteLinkAction(form: FormData): Promise<void> {
  await sameOrigin();
  const user = await requireUser();
  await deleteLink(user, String(form.get("id") ?? ""));
  revalidatePath("/dashboard");
}
