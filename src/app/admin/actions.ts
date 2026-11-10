"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { loadDemoWorkspace } from "@/lib/demo-workspace";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/errors";

export type DemoState = { error?: string; ok?: boolean; links?: number };

export async function loadDemoAction(_prev: DemoState, _form: FormData): Promise<DemoState> {
  void _form;
  try {
    requireSameOrigin(new Request(env().APP_URL, { headers: await headers() }));
    const user = await requireRole("admin");
    const result = await loadDemoWorkspace(user);
    revalidatePath("/admin");
    revalidatePath("/dashboard");
    return { ok: true, links: result.links };
  } catch (err) {
    if (err instanceof HttpError) return { error: err.message };
    throw err;
  }
}
