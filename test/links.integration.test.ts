/**
 * Runs against a real Postgres when TEST_DATABASE_URL is set (CI provides one).
 * Proves ownership, duplicate saves, tag foreign keys, save limits, and the queue cap.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("links data layer (Postgres)", () => {
  let sql: postgres.Sql;
  const alice = { id: "lk-alice", role: "user" as const };
  const bob = { id: "lk-bob", role: "user" as const };
  const admin = { id: "lk-admin", role: "admin" as const };
  const hour = { id: "lk-hour", role: "user" as const };
  const day = { id: "lk-day", role: "user" as const };
  const queuer = { id: "lk-queue", role: "user" as const };
  const flood = { id: "lk-flood", role: "user" as const };
  const cap = { id: "lk-cap", role: "user" as const };
  const pager = { id: "lk-pager", role: "user" as const };
  const retryer = { id: "lk-retry", role: "user" as const };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    await sql`delete from "user" where id like 'lk-%'`;
    for (const u of [alice, bob, admin, hour, day, queuer, flood, cap, pager, retryer]) {
      await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role})`;
    }
  });

  afterAll(async () => {
    await sql`delete from "user" where id like 'lk-%'`;
    await sql.end();
  });

  it("lets the owner read and change a link, and hides it from everyone else", async () => {
    const { saveLink, getLink, listLinks, patchLink, deleteLink } = await import("@/lib/links");
    const saved = await saveLink(alice, { url: "https://example.com/owned" });
    expect(saved.created).toBe(true);
    expect(saved.link.status).toBe("queued");

    const listed = await listLinks(alice, { view: "inbox" });
    expect(listed.links.some((link) => link.id === saved.link.id)).toBe(true);
    const adminList = await listLinks(admin);
    expect(adminList.links.some((link) => link.id === saved.link.id)).toBe(false);

    await expect(getLink(bob, saved.link.id)).rejects.toMatchObject({ status: 404 });
    await expect(getLink(admin, saved.link.id)).rejects.toMatchObject({ status: 404 });
    await expect(patchLink(bob, saved.link.id, { favorite: true })).rejects.toMatchObject({ status: 404 });
    await expect(deleteLink(admin, saved.link.id)).rejects.toMatchObject({ status: 404 });

    const patched = await patchLink(alice, saved.link.id, { favorite: true, read: true, tags: ["postgres", "databases"] });
    expect(patched.favorite).toBe(true);
    expect(patched.readAt).toBeTruthy();
    expect(patched.tags.map((tag) => tag.name).sort()).toEqual(["databases", "postgres"]);

    const tags = await (await import("@/lib/links")).listTags(alice);
    expect(tags.map((tag) => tag.name).sort()).toEqual(["databases", "postgres"]);

    await deleteLink(alice, saved.link.id);
    await expect(getLink(alice, saved.link.id)).rejects.toMatchObject({ status: 404 });
    await expect(getLink(alice, "not-a-uuid")).rejects.toMatchObject({ status: 404 });
  });

  it("returns the same link when the same URL is saved twice, and enqueues one fetch job", async () => {
    const { saveLink } = await import("@/lib/links");
    const first = await saveLink(alice, { url: "https://Example.com/twice?utm_source=newsletter#top" });
    const second = await saveLink(alice, { url: "https://example.com/twice" });
    expect(first.created).toBe(true);
    expect(first.link.url).toBe("https://example.com/twice");
    expect(second.created).toBe(false);
    expect(second.link.id).toBe(first.link.id);
    const [{ n }] = await sql`select count(*)::int as n from job where key = ${first.link.id} and status = 'queued'`;
    expect(n).toBe(1);

    await saveLink(alice, { url: "https://example.com/cursor-extra" });
    const { listLinks } = await import("@/lib/links");
    const page = await listLinks(alice, { limit: 1 });
    expect(page.links).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    const rest = await listLinks(alice, { limit: 1, cursor: page.nextCursor });
    expect(rest.links).toHaveLength(1);
    expect(rest.links[0].id).not.toBe(page.links[0].id);
  });

  it("stores a fixture article with its text and a summarize job (no fetch job), and search finds it only for the owner", async () => {
    const { saveLink, listLinks } = await import("@/lib/links");
    const saved = await saveLink(alice, { url: "https://example.com/read-later/postgres-indexes" });
    expect(saved.link.status).toBe("extracted");
    expect(saved.link.title).toMatch(/indexes/i);
    expect(saved.link.content?.paragraphs.length).toBeGreaterThan(0);
    const jobs = await sql`select kind from job where key = ${saved.link.id}`;
    expect(jobs.map((j) => j.kind)).toEqual(["summarize"]);
    const own = await listLinks(alice, { q: "indexes" });
    expect(own.links.some((link) => link.id === saved.link.id)).toBe(true);
    expect((await listLinks(bob, { q: "indexes" })).links).toHaveLength(0);
    expect((await listLinks(admin, { q: "indexes" })).links).toHaveLength(0);
  });

  it("pages through links with the cursor", async () => {
    const { listLinks } = await import("@/lib/links");
    await sql`
      insert into link (owner_id, url, url_hash, host, created_at)
      select ${pager.id}, 'https://example.com/page/' || g, md5(g::text) || md5('pager' || g::text), 'example.com', now() - (g || ' minutes')::interval
      from generate_series(1, 5) g
    `;
    const first = await listLinks(pager, { limit: 2 });
    expect(first.links).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listLinks(pager, { limit: 2, cursor: first.nextCursor });
    expect(second.links).toHaveLength(2);
    const third = await listLinks(pager, { limit: 2, cursor: second.nextCursor });
    expect(third.links).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
    const ids = [...first.links, ...second.links, ...third.links].map((l) => l.id);
    expect(new Set(ids).size).toBe(5);
  });

  it("refuses a cross-user tag attach at the foreign key", async () => {
    const { saveLink, patchLink } = await import("@/lib/links");
    const owned = await saveLink(alice, { url: "https://example.com/fk-link" });
    const other = await saveLink(bob, { url: "https://example.com/fk-other" });
    await patchLink(alice, owned.link.id, { tags: ["alpha-tag"] });
    await patchLink(bob, other.link.id, { tags: ["beta-tag"] });
    const [aliceTag] = await sql<{ id: string }[]>`select id from tag where owner_id = ${alice.id} and name = 'alpha-tag'`;
    const [bobTag] = await sql<{ id: string }[]>`select id from tag where owner_id = ${bob.id} and name = 'beta-tag'`;
    await expect(
      sql`insert into link_tag (link_id, tag_id, owner_id, source) values (${owned.link.id}, ${bobTag.id}, ${alice.id}, 'user')`,
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      sql`insert into link_tag (link_id, tag_id, owner_id, source) values (${other.link.id}, ${aliceTag.id}, ${bob.id}, 'user')`,
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses the 61st save in an hour and the 301st in a day", async () => {
    const { saveLink } = await import("@/lib/links");
    // Preinsert instead of saving 60 times: the per-user queue cap is 50, and it is checked after the rate limit.
    await sql`
      insert into rate_event (user_id, kind, at)
      select ${hour.id}, 'save', now() - interval '1 minute'
      from generate_series(1, 60)
    `;
    await expect(saveLink(hour, { url: "https://example.com/hour/more" })).rejects.toMatchObject({ status: 429 });

    await sql`
      insert into rate_event (user_id, kind, at)
      select ${day.id}, 'save', now() - interval '2 hours'
      from generate_series(1, 300)
    `;
    await expect(saveLink(day, { url: "https://example.com/day/more" })).rejects.toMatchObject({ status: 429 });
  });

  it("refuses the 51st queued fetch for one user", async () => {
    const { saveLink } = await import("@/lib/links");
    for (let i = 0; i < 50; i++) await saveLink(queuer, { url: `https://example.com/queue/${i}` });
    await expect(saveLink(queuer, { url: "https://example.com/queue/more" })).rejects.toMatchObject({ status: 429 });
    const [{ n }] = await sql`select count(*)::int as n from job where owner_id = ${queuer.id} and status = 'queued'`;
    expect(n).toBe(50);
  });

  it("refuses a save when the app already has 1000 queued jobs", async () => {
    const { saveLink } = await import("@/lib/links");
    try {
      await sql`
        insert into job (kind, owner_id, status, payload)
        select 'fetch', null, 'queued', '{"flood":true}'::jsonb
        from generate_series(1, 1000)
      `;
      await expect(saveLink(flood, { url: "https://example.com/flood" })).rejects.toMatchObject({ status: 503 });
    } finally {
      await sql`delete from job where owner_id is null and payload->>'flood' = 'true'`;
    }
  });

  it("refuses a save past 2000 links", async () => {
    const { saveLink } = await import("@/lib/links");
    await sql`
      insert into link (owner_id, url, url_hash, host)
      select ${cap.id}, 'https://example.com/cap/' || g, md5(g::text) || md5('cap' || g::text), 'example.com'
      from generate_series(1, 2000) g
    `;
    await expect(saveLink(cap, { url: "https://example.com/cap/more" })).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a blocked URL", async () => {
    const { saveLink } = await import("@/lib/links");
    await expect(saveLink(alice, { url: "http://169.254.169.254/latest" })).rejects.toMatchObject({ status: 400 });
    await expect(saveLink(alice, { url: "http://127.0.0.1/secret" })).rejects.toMatchObject({ status: 400 });
  });

  it("loads demo articles for an admin only, and only into that admin's library", async () => {
    const { loadDemoWorkspace } = await import("@/lib/demo-workspace");
    const { listLinks } = await import("@/lib/links");
    await expect(loadDemoWorkspace(alice)).rejects.toMatchObject({ status: 403 });
    const loaded = await loadDemoWorkspace(admin);
    expect(loaded.links).toBe(3);
    const found = await listLinks(admin, { q: "deploys" });
    expect(found.links.some((link) => link.title?.includes("reliable"))).toBe(true);
    expect((await listLinks(bob, { q: "deploys" })).links).toHaveLength(0);
    await expect(loadDemoWorkspace(admin)).rejects.toMatchObject({ status: 429 });
  });

  it("counts users and link statuses without returning URLs", async () => {
    const { adminCounts } = await import("@/lib/admin-counts");
    await expect(adminCounts(alice)).rejects.toMatchObject({ status: 403 });
    const counts = await adminCounts(admin);
    expect(counts.users).toBeGreaterThan(0);
    expect(counts.linksByStatus.queued).toBeGreaterThan(0);
    expect(counts.queue.queued).toBeGreaterThan(0);
    expect(JSON.stringify(counts)).not.toMatch(/https?:/);
    const { listUsers } = await import("@/lib/admin-counts");
    await expect(listUsers(alice)).rejects.toMatchObject({ status: 403 });
    const users = await listUsers(admin);
    expect(users.some((user) => user.id === admin.id)).toBe(true);
    expect(JSON.stringify(users)).not.toMatch(/password|token|https?:/);
  });

  it("retries a failed link for its owner, and stops after three in a day", async () => {
    const { saveLink, retryLink } = await import("@/lib/links");
    const saved = await saveLink(retryer, { url: "https://example.com/retry-me" });
    await expect(retryLink(retryer, saved.link.id)).rejects.toMatchObject({ status: 409 });
    await expect(retryLink(bob, saved.link.id)).rejects.toMatchObject({ status: 404 });

    const fail = async () => {
      await sql`update link set status = 'failed', fail_code = 'timeout' where id = ${saved.link.id}`;
      await sql`update job set status = 'failed', last_error = 'timeout' where key = ${saved.link.id} and owner_id = ${retryer.id}`;
    };
    for (let i = 0; i < 3; i++) {
      await fail();
      const again = await retryLink(retryer, saved.link.id);
      expect(again.status).toBe("queued");
      expect(again.failCode).toBeNull();
    }
    await fail();
    await expect(retryLink(retryer, saved.link.id)).rejects.toMatchObject({ status: 429 });
    await expect(retryLink(admin, saved.link.id)).rejects.toMatchObject({ status: 404 });
    const [row] = await sql<{ status: string }[]>`select status from link where id = ${saved.link.id}`;
    expect(row.status).toBe("failed");
  });
});
