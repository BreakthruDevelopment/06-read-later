/**
 * The summarize job against Postgres: idempotency per link and content hash, tags, regeneration caps, limits,
 * give-up state, owner-only access, and logs that carry no article text. The model is a stub (or the demo fixture).
 */
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AiError, type generate as Generate } from "@/lib/ai";
import { resetEnvCache } from "@/lib/env";
import { page, articleOf, INJECTION_IDS } from "./fixtures/pages";

const url = process.env.TEST_DATABASE_URL;
type Req = Parameters<typeof Generate>[0];

describe.skipIf(!url)("summaries (Postgres)", () => {
  let sql: postgres.Sql;
  let db: ReturnType<typeof import("@/lib/db").db>;
  let jobs: typeof import("@/lib/jobs/queue");
  let worker: typeof import("@/lib/jobs/worker");
  let run: typeof import("@/lib/summaries/run");
  const alice = { id: "sm-alice", role: "user" as const };
  const bob = { id: "sm-bob", role: "user" as const };
  const admin = { id: "sm-admin", role: "admin" as const };
  const rated = { id: "sm-rated", role: "user" as const };
  const capped = { id: "sm-capped", role: "user" as const };
  const queuer = { id: "sm-queuer", role: "user" as const };
  const users = [alice, bob, admin, rated, capped, queuer];
  const SECRET_PATH = "/private/path-with-token-9f8e7d";
  const SECRET_TITLE = "Unique secret title zebra";
  const SECRET_TEXT = "quokka-canary-sentence";

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.LOG_LEVEL = "error";
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await sql`delete from "user" where id like 'sm-%'`;
    for (const u of users) {
      await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role})`;
    }
    db = (await import("@/lib/db")).db();
    jobs = await import("@/lib/jobs/queue");
    worker = await import("@/lib/jobs/worker");
    run = await import("@/lib/summaries/run");
  });

  beforeEach(() => {
    vi.stubEnv("AI_PROVIDER", "demo");
    resetEnvCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  afterAll(async () => {
    await sql`delete from "user" where id like 'sm-%'`;
    await sql.end();
  });

  /** A stub for generate(): validates the canned answer like the real one and counts calls. */
  function stub(answer: unknown) {
    const calls: Req[] = [];
    const generate = (async (req: Req) => {
      calls.push(req);
      return { data: req.schema.parse(typeof answer === "function" ? (answer as () => unknown)() : answer), provider: "stub", model: "stub", demo: false, latencyMs: 2 };
    }) as unknown as typeof Generate;
    return { calls, deps: { generate } };
  }

  const GOOD = {
    summary: "A short neutral summary of the stored article.",
    keyPoints: ["First point", "Second point"],
    tags: ["postgres", "databases", "brand-new"],
    kind: "tutorial",
    lowQuality: false,
  };

  const TEXT = `${SECRET_TEXT} ${"A Postgres index lets the database find rows without reading the whole table. ".repeat(6)}`;

  async function makeLink(owner: { id: string }, opts: { text?: string; status?: string; title?: string; host?: string } = {}) {
    const id = randomUUID();
    const target = `https://${opts.host ?? "sm.example"}${SECRET_PATH}/${id}`;
    const text = opts.text ?? TEXT;
    const content = { paragraphs: text.split("\n\n"), text };
    await sql`
      insert into link (id, owner_id, url, url_hash, host, title, site_name, content, status)
      values (${id}, ${owner.id}, ${target}, ${createHash("sha256").update(target).digest("hex")}, ${opts.host ?? "sm.example"},
        ${opts.title ?? SECRET_TITLE}, 'Site', ${sql.json(content)}, ${opts.status ?? "extracted"})
    `;
    return id;
  }

  async function runJob(owner: { id: string }, linkId: string, deps: ReturnType<typeof stub>["deps"], extra: { maxAttempts?: number; payload?: Record<string, unknown> } = {}) {
    const { id } = await jobs.enqueue(db, { kind: "summarize", key: linkId, ownerId: owner.id, payload: { linkId, ...extra.payload }, maxAttempts: extra.maxAttempts });
    await worker
      .createWorker({
        handlers: { summarize: run.createSummarizeHandler(deps) },
        onGiveUp: { summarize: run.giveUpSummarize },
        concurrency: 1,
      })
      .kick({ ids: [id] });
    const [j] = await sql`select id, status, attempts, deferrals, last_error from job where id = ${id}`;
    return j;
  }

  const linkRow = async (id: string) => (await sql`select status, fail_code from link where id = ${id}`)[0];
  const summaryRow = async (id: string) => (await sql`select data, mode, input_hash, regenerations from link_summary where link_id = ${id}`)[0];
  const tagsOf = async (id: string) =>
    (await sql`select t.name, lt.source from link_tag lt join tag t on t.id = lt.tag_id where lt.link_id = ${id} order by t.name`).map((r) => `${r.name}:${r.source}`);

  it("summarizes an extracted link: stores the summary, marks it ready, and tags with existing tags plus at most 2 new ones", async () => {
    const existing = await sql`insert into tag (owner_id, name) values (${alice.id}, 'postgres'), (${alice.id}, 'databases') returning id`;
    expect(existing).toHaveLength(2);
    const id = await makeLink(alice);
    const { calls, deps } = stub({ ...GOOD, tags: ["postgres", "databases", "brand-new", "another-new", "third-new"] });
    const j = await runJob(alice, id, deps);
    expect(j.status).toBe("done");
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain('<existing_tags>["databases","postgres"]</existing_tags>');
    expect(await linkRow(id)).toMatchObject({ status: "ready", fail_code: null });
    const s = await summaryRow(id);
    expect(s.mode).toBe("live");
    expect(s.data.summary).toBe(GOOD.summary);
    expect(s.regenerations).toBe(0);
    expect(await tagsOf(id)).toEqual(["another-new:ai", "brand-new:ai", "databases:ai", "postgres:ai"]);
  });

  it("is idempotent per link and content: running it again with the same text makes no model call", async () => {
    const id = await makeLink(alice);
    const first = stub(GOOD);
    await runJob(alice, id, first.deps);
    expect(first.calls).toHaveLength(1);
    // A second fetch of the same text puts the link back to extracted and enqueues another summarize job.
    await sql`update link set status = 'extracted' where id = ${id}`;
    const second = stub(GOOD);
    const j = await runJob(alice, id, second.deps);
    expect(j.status).toBe("done");
    expect(second.calls).toHaveLength(0);
    expect(await linkRow(id)).toMatchObject({ status: "ready" });
    const [{ n }] = await sql`select count(*)::int as n from link_summary where link_id = ${id}`;
    expect(n).toBe(1);
  });

  it("summarizes again when the text changed", async () => {
    const id = await makeLink(alice);
    const first = stub(GOOD);
    await runJob(alice, id, first.deps);
    const before = await summaryRow(id);
    const changed = `${TEXT} And a brand new closing paragraph about partial indexes.`;
    await sql`update link set status = 'extracted', content = ${sql.json({ paragraphs: [changed], text: changed })} where id = ${id}`;
    const second = stub({ ...GOOD, summary: "A summary of the changed article." });
    await runJob(alice, id, second.deps);
    expect(second.calls).toHaveLength(1);
    const after = await summaryRow(id);
    expect(after.input_hash).not.toBe(before.input_hash);
    expect(after.data.summary).toBe("A summary of the changed article.");
  });

  it("makes no call for under 200 characters of text: mode skipped, link ready", async () => {
    const id = await makeLink(alice, { text: "Too short to summarize." });
    const { calls, deps } = stub(GOOD);
    const j = await runJob(alice, id, deps);
    expect(j.status).toBe("done");
    expect(calls).toHaveLength(0);
    expect(await linkRow(id)).toMatchObject({ status: "ready", fail_code: null });
    expect((await summaryRow(id)).mode).toBe("skipped");
    const { getLink } = await import("@/lib/links");
    const view = await getLink(alice, id);
    expect(view.summary).toMatchObject({ mode: "skipped", summary: null, keyPoints: [] });
  });

  it("runs the whole pipeline offline with the demo fixture: no network, no daily usage counted", async () => {
    const { saveLink, getLink } = await import("@/lib/links");
    const saved = await saveLink(bob, { url: "https://example.com/read-later/small-teams" });
    expect(saved.link.status).toBe("extracted");
    const [{ n }] = await sql`select count(*)::int as n from job where kind = 'summarize' and key = ${saved.link.id} and status = 'queued'`;
    expect(n).toBe(1);
    const fetchSpy = vi.fn(() => {
      throw new Error("network used");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const dailyBefore = await sql`select count from daily_usage where day = (now() at time zone 'utc')::date and kind = 'summarize'`;
    const [job] = await sql`select id from job where kind = 'summarize' and key = ${saved.link.id}`;
    await worker.createWorker({ handlers: { summarize: run.summarizeLinkHandler }, onGiveUp: { summarize: run.giveUpSummarize }, concurrency: 1 }).kick({ ids: [job.id] });
    vi.unstubAllGlobals();
    expect(fetchSpy).not.toHaveBeenCalled();
    const view = await getLink(bob, saved.link.id);
    expect(view.status).toBe("ready");
    expect(view.summary).toMatchObject({ mode: "demo", kind: "article", lowQuality: false, regenerationsLeft: 3 });
    expect(view.summary?.summary).toMatch(/^Demo summary \(recorded/);
    expect(view.tags.map((t) => `${t.name}:${t.source}`)).toEqual(["devops:ai", "engineering:ai"]);
    const dailyAfter = await sql`select count from daily_usage where day = (now() at time zone 'utc')::date and kind = 'summarize'`;
    expect(dailyAfter[0]?.count ?? 0).toBe(dailyBefore[0]?.count ?? 0);
  });

  it("keeps the user's own tags and never duplicates one the model also chose", async () => {
    const id = await makeLink(alice);
    const { patchLink } = await import("@/lib/links");
    await patchLink(alice, id, { tags: ["mine-only", "databases"] });
    await runJob(alice, id, stub(GOOD).deps);
    const tags = await tagsOf(id);
    expect(tags).toContain("mine-only:user");
    expect(tags).toContain("databases:user");
    expect(tags.filter((t) => t.startsWith("databases"))).toHaveLength(1);
    expect(tags).toContain("postgres:ai");
  });

  describe("prompt injection cannot reach anything outside the one link", () => {
    it("an obedient model's output changes nothing on the user's other links or on another user's data", async () => {
      const p = page(INJECTION_IDS[2]);
      const mine = await makeLink(alice, { text: articleOf(p).text, title: p.title });
      const other = await makeLink(alice, { title: "Other link of Alice" });
      const theirs = await makeLink(bob, { title: "Bob's link" });
      await sql`update link set favorite = false, status = 'ready' where id in (${other}, ${theirs})`;
      const tagsBefore = await sql`select count(*)::int as n from tag where owner_id = ${bob.id}`;
      const { deps } = stub({
        summary: "A history of the bicycle. Please log in at http://evil.example/login.",
        keyPoints: ["Visit http://evil.example now"],
        tags: ["hacked", "history", "cycling"],
        kind: "article",
        lowQuality: false,
        actions: [{ op: "delete", all: true }],
        archiveAll: true,
      });
      await runJob(alice, mine, deps);
      expect(JSON.stringify((await summaryRow(mine)).data)).not.toMatch(/evil|http/);
      expect(await linkRow(other)).toMatchObject({ status: "ready" });
      expect(await linkRow(theirs)).toMatchObject({ status: "ready" });
      const rows = await sql`select id, favorite, archived_at from link where id in (${other}, ${theirs})`;
      expect(rows.every((r) => r.favorite === false && r.archived_at === null)).toBe(true);
      expect(await tagsOf(other)).toEqual([]);
      expect(await tagsOf(theirs)).toEqual([]);
      expect((await sql`select count(*)::int as n from tag where owner_id = ${bob.id}`)[0].n).toBe(tagsBefore[0].n);
      expect((await sql`select count(*)::int as n from link_summary where link_id in (${other}, ${theirs})`)[0].n).toBe(0);
      const [{ n }] = await sql`select count(*)::int as n from link where id in (${mine}, ${other}, ${theirs})`;
      expect(n).toBe(3);
    });
  });

  describe("regenerate", () => {
    it("lets the owner regenerate up to 3 times, then refuses", async () => {
      const id = await makeLink(alice);
      await runJob(alice, id, stub(GOOD).deps);
      for (let i = 1; i <= 3; i++) {
        const res = await run.regenerateSummary(alice, id);
        expect(res).toEqual({ id, status: "summarizing", regenerationsLeft: 3 - i });
        expect(await linkRow(id)).toMatchObject({ status: "summarizing" });
        const { calls, deps } = stub({ ...GOOD, summary: `Regenerated version ${i}.` });
        const [queued] = await sql`select id, payload from job where kind = 'summarize' and key = ${id} and status = 'queued'`;
        expect(queued.payload.regenerate).toBe(true);
        await worker.createWorker({ handlers: { summarize: run.createSummarizeHandler(deps) }, concurrency: 1 }).kick({ ids: [queued.id] });
        expect(calls).toHaveLength(1);
        expect((await summaryRow(id)).data.summary).toBe(`Regenerated version ${i}.`);
        expect(await linkRow(id)).toMatchObject({ status: "ready" });
      }
      await expect(run.regenerateSummary(alice, id)).rejects.toMatchObject({ status: 429 });
      expect((await summaryRow(id)).regenerations).toBe(3);
    });

    it("regenerates through the worker with the queued job, replacing the summary once and not again on a re-run", async () => {
      const id = await makeLink(alice);
      await runJob(alice, id, stub(GOOD).deps);
      await run.regenerateSummary(alice, id);
      const [queued] = await sql`select id from job where kind = 'summarize' and key = ${id} and status = 'queued'`;
      const first = stub({ ...GOOD, summary: "Fresh summary." });
      const worker1 = worker.createWorker({ handlers: { summarize: run.createSummarizeHandler(first.deps) }, concurrency: 1 });
      await worker1.kick({ ids: [queued.id] });
      expect(first.calls).toHaveLength(1);
      expect((await summaryRow(id)).data.summary).toBe("Fresh summary.");
      expect(await linkRow(id)).toMatchObject({ status: "ready" });
      // The same job runs again (a crash before `complete`): the summary is newer than the request, so no second call.
      const [done] = await sql`select payload from job where id = ${queued.id}`;
      await sql`update link set status = 'summarizing' where id = ${id}`;
      const again = stub({ ...GOOD, summary: "Should not appear." });
      await runJob(alice, id, again.deps, { payload: done.payload });
      expect(again.calls).toHaveLength(0);
      expect((await summaryRow(id)).data.summary).toBe("Fresh summary.");
    });

    it("answers 404 to another user and to an admin, and 409 while a summary is in progress or the link has no text", async () => {
      const id = await makeLink(alice);
      await runJob(alice, id, stub(GOOD).deps);
      await expect(run.regenerateSummary(bob, id)).rejects.toMatchObject({ status: 404 });
      await expect(run.regenerateSummary(admin, id)).rejects.toMatchObject({ status: 404 });
      await expect(run.regenerateSummary(alice, "not-a-uuid")).rejects.toMatchObject({ status: 404 });
      await run.regenerateSummary(alice, id);
      await expect(run.regenerateSummary(alice, id)).rejects.toMatchObject({ status: 409 });
      const fetching = await makeLink(alice, { status: "fetching" });
      await expect(run.regenerateSummary(alice, fetching)).rejects.toMatchObject({ status: 409 });
      // Nothing about the refused attempts was recorded for the other users.
      expect((await sql`select count(*)::int as n from link_summary where link_id = ${id} and owner_id <> ${alice.id}`)[0].n).toBe(0);
    });

    it("refuses at the hourly cap up front with 429, before queuing anything", async () => {
      const id = await makeLink(rated);
      await runJob(rated, id, stub(GOOD).deps);
      await sql`insert into rate_event (user_id, kind) select ${rated.id}, 'summarize' from generate_series(1, 30)`;
      await expect(run.regenerateSummary(rated, id)).rejects.toMatchObject({ status: 429 });
      const [{ n }] = await sql`select count(*)::int as n from job where kind = 'summarize' and key = ${id} and status = 'queued'`;
      expect(n).toBe(0);
      await sql`delete from rate_event where user_id = ${rated.id}`;
    });

    it("exposes the route contract: owner 202, others 404, anonymous 401", async () => {
      const id = await makeLink(alice);
      await runJob(alice, id, stub(GOOD).deps);
      vi.doMock("@/lib/auth/session", async () => {
        const rbac = await import("@/lib/auth/rbac");
        let current: { id: string; role: "user" | "admin" } | null = alice;
        return {
          requireUser: async () => {
            if (!current) throw new rbac.UnauthorizedError();
            return current;
          },
          __setUser: (u: typeof current) => {
            current = u;
          },
        };
      });
      vi.doMock("next/server", () => ({ after: () => undefined }));
      vi.doMock("@/lib/csrf", () => ({ requireSameOrigin: () => undefined }));
      vi.resetModules();
      const session = (await import("@/lib/auth/session")) as unknown as { __setUser: (u: unknown) => void };
      const { POST } = await import("@/app/api/links/[id]/summary/route");
      const call = (target: string) => POST(new Request(`http://localhost/api/links/${target}/summary`, { method: "POST" }), { params: Promise.resolve({ id: target }) });
      session.__setUser(bob);
      expect((await call(id)).status).toBe(404);
      session.__setUser(admin);
      expect((await call(id)).status).toBe(404);
      session.__setUser(null);
      expect((await call(id)).status).toBe(401);
      session.__setUser(alice);
      const ok = await call(id);
      expect(ok.status).toBe(202);
      expect(await ok.json()).toEqual({ id, status: "summarizing", regenerationsLeft: 2 });
      vi.doUnmock("@/lib/auth/session");
      vi.doUnmock("next/server");
      vi.doUnmock("@/lib/csrf");
      vi.resetModules();
    });
  });

  describe("failure", () => {
    it("retries a failing model call, refunds the hourly count, and on give-up leaves the link readable with summary_failed", async () => {
      const id = await makeLink(alice);
      const generate = (async () => {
        throw new AiError("down", "provider", 503);
      }) as unknown as typeof Generate;
      const before = (await sql`select count(*)::int as n from rate_event where user_id = ${alice.id} and kind = 'summarize'`)[0].n;
      const j = await runJob(alice, id, { generate }, { maxAttempts: 1 });
      expect(j.status).toBe("failed");
      expect(j.last_error).toBe("ai_failed");
      expect(await linkRow(id)).toMatchObject({ status: "ready", fail_code: "summary_failed" });
      expect((await sql`select count(*)::int as n from rate_event where user_id = ${alice.id} and kind = 'summarize'`)[0].n).toBe(before);
      expect(await summaryRow(id)).toBeUndefined();
      // The owner can regenerate from this state, which makes a placeholder row to count it.
      const res = await run.regenerateSummary(alice, id);
      expect(res.regenerationsLeft).toBe(2);
      expect(await linkRow(id)).toMatchObject({ status: "summarizing", fail_code: null });
      const { getLink } = await import("@/lib/links");
      expect((await getLink(alice, id)).summary).toMatchObject({ mode: "pending", summary: null, regenerationsLeft: 2 });
    });

    it("an answer that is not valid output is a retryable failure, and a transient error leaves the job queued with a backoff", async () => {
      const id = await makeLink(alice);
      const generate = (async () => {
        throw new AiError("bad", "invalid_output");
      }) as unknown as typeof Generate;
      const j = await runJob(alice, id, { generate });
      expect(j.status).toBe("queued");
      expect(j.last_error).toBe("ai_invalid_output");
      expect(await linkRow(id)).toMatchObject({ status: "summarizing" });
    });

    it("does not write when the text changed while the model was working: the job runs again on the new text", async () => {
      const id = await makeLink(alice);
      const generate = (async (req: Req) => {
        const changed = `${TEXT} Added while the model was thinking.`;
        await sql`update link set content = ${sql.json({ paragraphs: [changed], text: changed })} where id = ${id}`;
        return { data: req.schema.parse(GOOD), provider: "stub", model: "stub", demo: false, latencyMs: 1 };
      }) as unknown as typeof Generate;
      const j = await runJob(alice, id, { generate });
      expect(j.status).toBe("queued");
      expect(j.last_error).toBe("stale");
      expect(await summaryRow(id)).toBeUndefined();
      const second = stub(GOOD);
      await sql`update job set run_after = now() - interval '1 second' where id = ${j.id}`;
      await worker.createWorker({ handlers: { summarize: run.createSummarizeHandler(second.deps) }, concurrency: 1 }).kick({ ids: [j.id] });
      expect(second.calls).toHaveLength(1);
      expect(await linkRow(id)).toMatchObject({ status: "ready" });
    });
  });

  describe("limits", () => {
    it("defers when the user is at 30 summaries this hour, and makes no model call", async () => {
      const id = await makeLink(rated);
      await sql`insert into rate_event (user_id, kind) select ${rated.id}, 'summarize' from generate_series(1, 30)`;
      const { calls, deps } = stub(GOOD);
      const j = await runJob(rated, id, deps);
      expect(calls).toHaveLength(0);
      expect(j.status).toBe("queued");
      expect(j.last_error).toBe("rate_limited");
      expect(Number(j.deferrals)).toBe(1);
      expect(Number(j.attempts)).toBe(0);
      await sql`delete from rate_event where user_id = ${rated.id}`;
    });

    it("counts live model calls against SUMMARY_DAILY_CAP and defers at the cap, with no call", async () => {
      vi.stubEnv("AI_PROVIDER", "gemini");
      vi.stubEnv("GEMINI_API_KEY", "test-key-not-real");
      resetEnvCache();
      const [prev] = await sql`select count from daily_usage where day = (now() at time zone 'utc')::date and kind = 'summarize'`;
      try {
        await sql`
          insert into daily_usage (day, kind, count) values ((now() at time zone 'utc')::date, 'summarize', 10)
          on conflict (day, kind) do update set count = 10`;
        const id = await makeLink(capped);
        const ok = stub(GOOD);
        await runJob(capped, id, ok.deps);
        expect(ok.calls).toHaveLength(1);
        const [{ count }] = await sql`select count from daily_usage where day = (now() at time zone 'utc')::date and kind = 'summarize'`;
        expect(count).toBe(11);

        await sql`update daily_usage set count = 300 where day = (now() at time zone 'utc')::date and kind = 'summarize'`;
        const blocked = await makeLink(capped);
        const none = stub(GOOD);
        const rateBefore = (await sql`select count(*)::int as n from rate_event where user_id = ${capped.id} and kind = 'summarize'`)[0].n;
        const j = await runJob(capped, blocked, none.deps);
        expect(none.calls).toHaveLength(0);
        expect(j.last_error).toBe("summary_cap");
        expect((await sql`select count(*)::int as n from rate_event where user_id = ${capped.id} and kind = 'summarize'`)[0].n).toBe(rateBefore);
        const [{ count: after }] = await sql`select count from daily_usage where day = (now() at time zone 'utc')::date and kind = 'summarize'`;
        expect(after).toBe(300);
      } finally {
        await sql`
          insert into daily_usage (day, kind, count) values ((now() at time zone 'utc')::date, 'summarize', ${prev?.count ?? 0})
          on conflict (day, kind) do update set count = ${prev?.count ?? 0}`;
      }
    });
  });

  it("logs the task, mode, host and guardrail codes, never the title, the text or the URL path", async () => {
    process.env.LOG_LEVEL = "debug";
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l?: unknown) => void lines.push(String(l)));
    vi.spyOn(console, "error").mockImplementation((l?: unknown) => void lines.push(String(l)));
    const id = await makeLink(alice, { host: "logs.example" });
    const { deps } = stub({ ...GOOD, summary: `Summary mentions ${SECRET_TEXT}. See http://evil.example/x for more.` });
    await runJob(alice, id, deps);
    // A failing one too.
    const failing = await makeLink(alice, { host: "logs.example" });
    const generate = (async () => {
      throw new AiError(`provider said ${SECRET_TEXT}`, "provider", 500);
    }) as unknown as typeof Generate;
    await runJob(alice, failing, { generate }, { maxAttempts: 1 });
    process.env.LOG_LEVEL = "error";
    const blob = lines.join("\n");
    expect(blob).toContain('"msg":"summarize.done"');
    expect(blob).toContain('"host":"logs.example"');
    expect(blob).toContain("url_stripped");
    for (const secret of [SECRET_TITLE, SECRET_TEXT, SECRET_PATH, "evil.example", "private/path"]) expect(blob).not.toContain(secret);
  });

  describe("a live-configured app never stores the recorded demo answer", () => {
    const demoAnswer = {
      summary: "Demo summary (recorded, not from a live model): the article explains how small teams ship reliable software by automating tests and deploys.",
      keyPoints: ["Automated checks catch routine mistakes"],
      tags: ["engineering", "devops"],
      kind: "article",
      lowQuality: false,
    };
    /** What generate() returns when the live provider failed and AI_FALLBACK_TO_DEMO is true. */
    const fallbackDeps = () => {
      const calls: Req[] = [];
      const generate = (async (req: Req) => {
        calls.push(req);
        return { data: req.schema.parse(demoAnswer), provider: "demo", model: "recorded", demo: true, latencyMs: 1 };
      }) as unknown as typeof Generate;
      return { calls, deps: { generate } };
    };

    it("refunds both counters, creates no tags, stores no summary or hash, and retries; after the last attempt the link is summary_failed", async () => {
      vi.stubEnv("AI_PROVIDER", "gemini");
      vi.stubEnv("GEMINI_API_KEY", "test-key-not-real");
      vi.stubEnv("AI_FALLBACK_TO_DEMO", "true");
      resetEnvCache();
      const daily = async () => (await sql`select count from daily_usage where day = (now() at time zone 'utc')::date and kind = 'summarize'`)[0]?.count ?? 0;
      const rate = async () => (await sql`select count(*)::int as n from rate_event where user_id = ${alice.id} and kind = 'summarize'`)[0].n;
      const [dailyBefore, rateBefore] = [await daily(), await rate()];
      const tagsBefore = (await sql`select count(*)::int as n from tag where owner_id = ${alice.id}`)[0].n;

      const id = await makeLink(alice);
      const first = fallbackDeps();
      const j = await runJob(alice, id, first.deps);
      expect(first.calls).toHaveLength(1);
      expect(j.status).toBe("queued");
      expect(j.last_error).toBe("ai_failed");
      expect(await summaryRow(id)).toBeUndefined();
      expect(await tagsOf(id)).toEqual([]);
      expect((await sql`select count(*)::int as n from tag where owner_id = ${alice.id} and name in ('engineering', 'devops')`)[0].n).toBe(0);
      expect((await sql`select count(*)::int as n from tag where owner_id = ${alice.id}`)[0].n).toBe(tagsBefore);
      expect(await daily()).toBe(dailyBefore);
      expect(await rate()).toBe(rateBefore);
      expect(await linkRow(id)).toMatchObject({ status: "summarizing" });

      const last = await makeLink(alice);
      const lastRun = await runJob(alice, last, fallbackDeps().deps, { maxAttempts: 1 });
      expect(lastRun.status).toBe("failed");
      expect(await linkRow(last)).toMatchObject({ status: "ready", fail_code: "summary_failed" });
      expect(await summaryRow(last)).toBeUndefined();
      expect(await daily()).toBe(dailyBefore);
    });

    it("still stores the recorded answer when the app is configured for demo, since that is the demo", async () => {
      const id = await makeLink(alice);
      await runJob(alice, id, fallbackDeps().deps);
      expect((await summaryRow(id)).mode).toBe("demo");
    });
  });

  it("stores nothing when every sentence of the summary is risky: the job fails for good and the link is summary_failed", async () => {
    const id = await makeLink(alice);
    const { calls, deps } = stub({
      summary: "Sign in at paypal-verify.support to keep your account.",
      keyPoints: ["Call 0800-555-0199 now"],
      tags: ["finance", "urgent"],
      kind: "article",
      lowQuality: false,
    });
    const tagsBefore = (await sql`select count(*)::int as n from tag where owner_id = ${alice.id}`)[0].n;
    const j = await runJob(alice, id, deps);
    expect(calls).toHaveLength(1);
    expect(j.status).toBe("failed");
    expect(j.last_error).toBe("summary_rejected");
    expect(await summaryRow(id)).toBeUndefined();
    expect(await tagsOf(id)).toEqual([]);
    expect((await sql`select count(*)::int as n from tag where owner_id = ${alice.id}`)[0].n).toBe(tagsBefore);
    expect(await linkRow(id)).toMatchObject({ status: "ready", fail_code: "summary_failed" });
  });

  it("saving a bundled fixture counts against the queue caps like any other save", async () => {
    const { saveLink } = await import("@/lib/links");
    await sql`
      insert into job (kind, owner_id, status, payload)
      select 'fetch', ${queuer.id}, 'queued', '{}'::jsonb from generate_series(1, 50)
    `;
    await expect(saveLink(queuer, { url: "https://example.com/read-later/postgres-indexes" })).rejects.toMatchObject({ status: 429 });
    const [{ n }] = await sql`select count(*)::int as n from link where owner_id = ${queuer.id}`;
    expect(n).toBe(0);
    await sql`delete from job where owner_id = ${queuer.id}`;
  });

  it("only the owner's id can write a summary: a job for someone else's link does nothing", async () => {
    const id = await makeLink(alice);
    const { calls, deps } = stub(GOOD);
    const j = await runJob(bob, id, deps); // job claims bob owns alice's link
    expect(j.status).toBe("done");
    expect(calls).toHaveLength(0);
    expect(await summaryRow(id)).toBeUndefined();
    expect(await linkRow(id)).toMatchObject({ status: "extracted" });
  });
});
