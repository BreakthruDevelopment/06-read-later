import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { DEMO_EMAIL_DOMAIN, MARKER } from "@/lib/demo-identity";
import { demoSeedConfig } from "@/lib/demo-seed-config";
import { ConflictError } from "@/lib/errors";
import { upsertFixtures } from "@/lib/links";
import { consumeRate } from "@/lib/usage";

const DEMO_EMAIL = `reader@${DEMO_EMAIL_DOMAIN}`;

const optionsSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("admin") }).strict(),
  z.object({ mode: z.literal("cli") }).strict(),
]);

/**
 * Load the bundled articles into a library. Admin mode writes them on the caller's own account
 * (an admin cannot read anyone else's links). CLI mode creates the demo reader and writes them there.
 * Neither path fetches a URL.
 */
export async function loadDemoWorkspace(actor: Actor, options: unknown = { mode: "admin" }): Promise<{ users: number; links: number }> {
  assertCan(actor, "update");
  const parsed = optionsSchema.parse(options);
  if (parsed.mode === "cli") {
    const { password } = demoSeedConfig();
    const owner = await ensureDemoReader(password);
    const links = await db().transaction((tx) => upsertFixtures(tx, owner.id));
    return { users: 1, links };
  }
  const links = await db().transaction(async (tx) => {
    await consumeRate(tx, actor.id, "demo_load", 1, "Demo workspace can be loaded once per minute. Try again shortly.", {
      windowSeconds: 60,
    });
    return upsertFixtures(tx, actor.id);
  });
  return { users: 0, links };
}

async function ensureDemoReader(password: string): Promise<Actor> {
  const [existing] = await db().select().from(schema.user).where(eq(schema.user.email, DEMO_EMAIL));
  if (existing && existing.image !== MARKER) {
    throw new ConflictError("A demo email belongs to an unrelated account; no demo data was replaced.");
  }
  const api = auth();
  if (!existing) {
    const created = await api.api.createUser({
      body: { email: DEMO_EMAIL, name: "Demo Reader", password, role: "user", data: { image: MARKER } },
    });
    return { id: created.user.id, role: "user" };
  }
  const ctx = await api.$context;
  await ctx.internalAdapter.updatePassword(existing.id, await ctx.password.hash(password));
  await ctx.internalAdapter.deleteUserSessions(existing.id);
  return { id: existing.id, role: "user" };
}
