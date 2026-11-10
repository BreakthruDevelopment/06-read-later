/**
 * The CLI demo loader creates its reader with Drizzle, so the demo-identity auth hooks don't block it;
 * it still refuses to adopt an unrelated account that holds the demo email.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const EMAIL = "reader@demo.breakthru.test";

describe.skipIf(!url)("demo reader loader (CLI mode)", () => {
  let sql: postgres.Sql;
  const admin = { id: "dwc-admin", role: "admin" as const };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = "http://localhost:3000";
    process.env.DEMO_SEED = "yes";
    process.env.DEMO_PASSWORD = "demo-reader-password-1";
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where email = ${EMAIL}`;
  });

  afterAll(async () => {
    await sql`delete from "user" where email = ${EMAIL}`;
    await sql.end();
  });

  it("creates the marked demo reader with a credential account, and can run again", async () => {
    const { loadDemoWorkspace } = await import("@/lib/demo-workspace");
    const { MARKER } = await import("@/lib/demo-identity");
    expect((await loadDemoWorkspace(admin, { mode: "cli" })).users).toBe(1);
    const [row] = await sql`select id, image from "user" where email = ${EMAIL}`;
    expect(row.image).toBe(MARKER);
    expect(await sql`select 1 from account where user_id = ${row.id} and provider_id = 'credential'`).toHaveLength(1);
    await loadDemoWorkspace(admin, { mode: "cli" });
    expect(await sql`select 1 from "user" where email = ${EMAIL}`).toHaveLength(1);
  });

  it("answers 409 when an unrelated account holds the demo email", async () => {
    const { loadDemoWorkspace } = await import("@/lib/demo-workspace");
    await sql`update "user" set image = null where email = ${EMAIL}`;
    await expect(loadDemoWorkspace(admin, { mode: "cli" })).rejects.toMatchObject({ status: 409 });
  });
});
