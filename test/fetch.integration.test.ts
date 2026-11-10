/**
 * Fetch pipeline against Postgres: extraction through the worker, retry backoff, a lease
 * left behind by a killed process, and per-host spacing. HTTP fixtures stay in safe-fetch.test.ts.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSafeFetch, SafeFetchError, type SafeFetchResult } from "@/lib/safe-fetch";

const url = process.env.TEST_DATABASE_URL;
const CANARY = "super-secret-token";
const ARTICLE = `<!doctype html><html><head><title>Pinned fetch title</title></head><body>
<script>${CANARY}</script>
<article>
<h1>Pinned fetch title</h1>
<p>A Postgres index lets the database find rows without reading the whole table.</p>
<p>B-tree indexes are the default and fit equality and range filters on ordinary columns.</p>
<p>Partial indexes store only the rows that match a predicate, which keeps them small.</p>
</article>
</body></html>`;

describe.skipIf(!url)("fetch pipeline (Postgres)", () => {
  let sql: postgres.Sql;
  let db: ReturnType<typeof import("@/lib/db").db>;
  let jobs: typeof import("@/lib/jobs/queue");
  let worker: typeof import("@/lib/jobs/worker");
  let run: typeof import("@/lib/fetch/run");
  let host: typeof import("@/lib/fetch/host");
  const owner = { id: "ft-owner", role: "user" as const };
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.LOG_LEVEL = "error";
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await sql`insert into "user" (id, name, email, role) values (${owner.id}, 'Fetch', ${owner.id + "@test.local"}, ${owner.role}) on conflict do nothing`;
    db = (await import("@/lib/db")).db();
    jobs = await import("@/lib/jobs/queue");
    worker = await import("@/lib/jobs/worker");
    run = await import("@/lib/fetch/run");
    host = await import("@/lib/fetch/host");
    server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(ARTICLE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.LOG_LEVEL = "error";
  });

  afterAll(async () => {
    server.close();
    await sql`delete from "user" where id like 'ft-%'`;
    await sql`delete from fetch_host where host like '%.ft.example'`;
    await sql.end();
  });

  const jobFor = async (linkId: string) =>
    (await sql`select id, status, attempts, deferrals, last_error, extract(epoch from (run_after - now())) as in_secs from job where key = ${linkId} and kind = 'fetch' order by created_at desc limit 1`)[0];

  async function save(raw: string) {
    const { saveLink } = await import("@/lib/links");
    return saveLink(owner, { url: raw });
  }

  function htmlResult(target: string, status = 200): SafeFetchResult {
    return { status, url: target, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(ARTICLE) };
  }

  it("adds queue counts to /api/health", async () => {
    const { GET } = await import("@/app/api/health/route");
    const body = (await (await GET()).json()) as { queue: { queued: number; oldestSeconds: number } };
    expect(body.queue).toEqual({ queued: expect.any(Number), oldestSeconds: expect.any(Number) });
    expect(Object.keys(body.queue).sort()).toEqual(["oldestSeconds", "queued"]);
    const queued = await jobs.enqueue(db, { kind: "fetch", key: crypto.randomUUID(), ownerId: owner.id, payload: { linkId: crypto.randomUUID() } });
    const after = (await (await GET()).json()) as { queue: { queued: number } };
    expect(after.queue.queued).toBeGreaterThanOrEqual(body.queue.queued + 1);
    await sql`delete from job where id = ${queued.id}`;
  });

  it("fetches the stored URL through a pinned local server, extracts text, and logs the host only", async () => {
    const target = `http://public.ft.example:${port}/secret-path?token=${CANARY}`;
    const linkId = crypto.randomUUID();
    await sql`
      insert into link (id, owner_id, url, url_hash, host, status)
      values (${linkId}, ${owner.id}, ${target}, ${createHash("sha256").update(target).digest("hex")}, 'public.ft.example', 'queued')
    `;
    const enqueued = await jobs.enqueue(db, { kind: "fetch", key: linkId, ownerId: owner.id, payload: { linkId } });
    const seen: string[] = [];
    const fetcher = createSafeFetch({
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      isPublic: (address) => address === "127.0.0.1",
    });
    const lines: string[] = [];
    process.env.LOG_LEVEL = "info";
    const logSpy = vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      lines.push(String(line));
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation((line?: unknown) => {
      lines.push(String(line));
    });
    const handler = run.createFetchHandler({
      fetch: async (input, opts) => {
        seen.push(input);
        return fetcher(input, opts);
      },
      allowedPorts: [port],
    });
    await worker.createWorker({ handlers: { fetch: handler }, concurrency: 2 }).kick({ ids: [enqueued.id] });
    logSpy.mockRestore();
    errSpy.mockRestore();

    expect(seen).toEqual([target]);
    const [link] = await sql`select status, title, content, final_url, fail_code from link where id = ${linkId}`;
    expect(link.status).toBe("extracted");
    expect(link.fail_code).toBeNull();
    expect(link.title).toContain("Pinned fetch");
    expect(JSON.stringify(link.content)).toContain("without reading the whole table");
    expect(JSON.stringify(link.content)).not.toContain(CANARY);
    expect(JSON.stringify(link.content)).not.toContain("<script");
    expect(link.final_url).toBe(target);
    const [summary] = await sql`select payload, status from job where kind = 'summarize' and key = ${linkId}`;
    expect(summary.status).toBe("queued");
    expect(JSON.stringify(summary.payload)).not.toContain(CANARY);
    expect(JSON.stringify(summary.payload)).toContain(linkId);

    const blob = lines.join("\n");
    expect(blob).toContain("public.ft.example");
    expect(blob).not.toContain(CANARY);
    expect(blob).not.toContain("secret-path");
    expect(blob).not.toContain(String(port));

    await handler(
      { id: enqueued.id, kind: "fetch", key: linkId, ownerId: owner.id, payload: { linkId } },
      { signal: new AbortController().signal, attempt: 1, maxAttempts: 4 },
    );
    expect(seen).toEqual([target]);
    const [{ n }] = await sql`select count(*)::int as n from job where kind = 'summarize' and key = ${linkId} and status = 'queued'`;
    expect(n).toBe(1);
  });

  it("fails a link at once for a blocked address, a 4xx, a huge body and a bad type, and retries 429", async () => {
    const cases: { host: string; error?: SafeFetchError; status?: number; code: string; permanent: boolean }[] = [
      { host: "blocked.ft.example", error: new SafeFetchError("blocked"), code: "blocked_address", permanent: true },
      { host: "missing.ft.example", status: 404, code: "http_4xx", permanent: true },
      { host: "huge.ft.example", error: new SafeFetchError("too_large"), code: "too_large", permanent: true },
      { host: "kind.ft.example", error: new SafeFetchError("bad_content_type"), code: "bad_content_type", permanent: true },
      { host: "later.ft.example", status: 429, code: "http_429", permanent: false },
      { host: "down.ft.example", status: 503, code: "http_5xx", permanent: false },
    ];
    for (const item of cases) {
      const saved = await save(`https://${item.host}/page`);
      let calls = 0;
      const handler = run.createFetchHandler({
        fetch: async (input) => {
          calls += 1;
          if (item.error) throw item.error;
          return htmlResult(input, item.status);
        },
      });
      const row = await jobFor(saved.link.id);
      await worker.createWorker({ handlers: { fetch: handler }, concurrency: 1 }).kick({ ids: [row.id] });
      const after = await jobFor(saved.link.id);
      const [link] = await sql`select status, fail_code from link where id = ${saved.link.id}`;
      expect(calls, item.host).toBe(1);
      if (item.permanent) {
        expect(after.status, item.host).toBe("failed");
        expect(link.status, item.host).toBe("failed");
        expect(link.fail_code, item.host).toBe(item.code);
      } else {
        expect(after.status, item.host).toBe("queued");
        expect(after.last_error, item.host).toBe(item.code);
        expect(Number(after.in_secs), item.host).toBeGreaterThan(10);
        expect(Number(after.in_secs), item.host).toBeLessThanOrEqual(15);
        expect(link.status, item.host).toBe("queued");
        expect(link.fail_code, item.host).toBeNull();
      }
    }
  });

  it("backs off 15s, 1 min and 4 min, then fails the link", async () => {
    const saved = await save("https://retry.ft.example/flaky");
    const handler = run.createFetchHandler({
      fetch: async () => {
        throw new SafeFetchError("network");
      },
    });
    const expected = [15, 60, 240];
    for (const secs of expected) {
      const row = await jobFor(saved.link.id);
      await worker.createWorker({ handlers: { fetch: handler }, concurrency: 1 }).kick({ ids: [row.id] });
      const after = await jobFor(saved.link.id);
      expect(after.status).toBe("queued");
      expect(after.last_error).toBe("network");
      expect(Number(after.in_secs)).toBeGreaterThan(secs - 3);
      expect(Number(after.in_secs)).toBeLessThanOrEqual(secs);
      const [link] = await sql`select status, fail_code from link where id = ${saved.link.id}`;
      expect(link).toMatchObject({ status: "queued", fail_code: null });
      // The real backoff is 15s or more, which is past the 2s host gap. The test makes the job due immediately, so open the gap too.
      await sql`update fetch_host set next_allowed_at = now() - interval '1 second', in_flight = false where host = 'retry.ft.example'`;
      await sql`update job set run_after = now() - interval '1 second' where id = ${row.id}`;
    }
    const last = await jobFor(saved.link.id);
    expect(last.attempts).toBe(3);
    await sql`update fetch_host set next_allowed_at = now() - interval '1 second', in_flight = false where host = 'retry.ft.example'`;
    await worker.createWorker({ handlers: { fetch: handler }, concurrency: 1 }).kick({ ids: [last.id] });
    const done = await jobFor(saved.link.id);
    expect(done).toMatchObject({ status: "failed", attempts: 4, last_error: "network" });
    const [link] = await sql`select status, fail_code from link where id = ${saved.link.id}`;
    expect(link).toMatchObject({ status: "failed", fail_code: "network" });
  });

  it("finishes a link whose fetch was left running by a killed process", async () => {
    const saved = await save("https://lease.ft.example/article?b=1&a=2");
    const row = await jobFor(saved.link.id);
    const claimed = (await jobs.claim(db, { kinds: ["fetch"], limit: 1, leaseMs: 60_000, ids: [row.id] }))[0];
    expect(claimed.attempts).toBe(1);
    await sql`update job set locked_until = now() - interval '1 second' where id = ${row.id}`;
    let seen = "";
    const handler = run.createFetchHandler({
      fetch: async (input) => {
        seen = input;
        return htmlResult(input);
      },
    });
    await worker.createWorker({ handlers: { fetch: handler }, concurrency: 1 }).kick({ ids: [row.id] });
    expect(seen).toBe(saved.link.url);
    expect(saved.link.url).toBe("https://lease.ft.example/article?b=1&a=2");
    expect((await jobFor(saved.link.id)).status).toBe("done");
    const [link] = await sql`select status, content from link where id = ${saved.link.id}`;
    expect(link.status).toBe("extracted");
    expect(JSON.stringify(link.content)).toContain("without reading the whole table");
  });

  const linkRow = async (id: string) => (await sql`select status, fail_code from link where id = ${id}`)[0];

  it("fails a link permanently as too_complex for a deeply nested page, quickly", async () => {
    const saved = await save("https://nested.ft.example/deep");
    const bomb = "<div>".repeat(60_000) + "text" + "</div>".repeat(60_000);
    const handler = run.createFetchHandler({
      fetch: async (input) => ({ ...htmlResult(input), body: Buffer.from(bomb) }),
    });
    const row = await jobFor(saved.link.id);
    const started = Date.now();
    await worker.createWorker({ handlers: { fetch: handler }, concurrency: 1 }).kick({ ids: [row.id] });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await jobFor(saved.link.id)).toMatchObject({ status: "failed", attempts: 1, last_error: "too_complex" });
    expect(await linkRow(saved.link.id)).toMatchObject({ status: "failed", fail_code: "too_complex" });
  });

  it("marks the link failed when the worker is killed on the last attempt", async () => {
    const saved = await save("https://killed.ft.example/last");
    const row = await jobFor(saved.link.id);
    await sql`update job set attempts = max_attempts - 1 where id = ${row.id}`;
    const claimed = (await jobs.claim(db, { kinds: ["fetch"], limit: 1, leaseMs: 60_000, ids: [row.id] }))[0];
    expect(claimed.attempts).toBe(claimed.maxAttempts);
    await sql`update link set status = 'fetching' where id = ${saved.link.id}`; // what the dead process left behind
    await sql`update job set locked_until = now() - interval '1 second' where id = ${row.id}`;
    const never = run.createFetchHandler({
      fetch: async () => {
        throw new Error("must not run again");
      },
    });
    const w = worker.createWorker({ handlers: { fetch: never }, onGiveUp: { fetch: run.giveUpFetch }, intervalMs: 60_000, concurrency: 1 });
    w.start();
    try {
      for (let i = 0; i < 100 && (await linkRow(saved.link.id)).status !== "failed"; i++) await new Promise((r) => setTimeout(r, 50));
    } finally {
      await w.stop();
    }
    expect(await jobFor(saved.link.id)).toMatchObject({ status: "failed", last_error: "lease_expired" });
    expect(await linkRow(saved.link.id)).toMatchObject({ status: "failed", fail_code: "lease_expired" });
  });

  it("marks the link failed when a deferral is the final outcome, and keeps it queued while retries remain", async () => {
    const saved = await save("https://deferred.ft.example/busy");
    const row = await jobFor(saved.link.id);
    const handler = run.createFetchHandler({
      fetch: async () => {
        throw new Error("must not fetch while the host is busy");
      },
    });
    const hooks = { fetch: run.giveUpFetch };
    const lease = await host.claimHost("deferred.ft.example");
    expect(lease).toBeTruthy();
    // Retries remain: the deferral is not a failure, and the link stays queued.
    await worker.createWorker({ handlers: { fetch: handler }, onGiveUp: hooks, concurrency: 1 }).kick({ ids: [row.id] });
    expect(await jobFor(saved.link.id)).toMatchObject({ status: "queued", last_error: "host_busy" });
    expect(await linkRow(saved.link.id)).toMatchObject({ status: "queued", fail_code: null });
    // Deferrals and attempts both used up: the next deferral ends the job, and the link needs a Retry button.
    await sql`update job set run_after = now() - interval '1 second', attempts = max_attempts - 1, deferrals = 20 where id = ${row.id}`;
    await worker.createWorker({ handlers: { fetch: handler }, onGiveUp: hooks, concurrency: 1 }).kick({ ids: [row.id] });
    expect(await jobFor(saved.link.id)).toMatchObject({ status: "failed", last_error: "host_busy" });
    expect(await linkRow(saved.link.id)).toMatchObject({ status: "failed", fail_code: "host_busy" });
    await host.releaseHost("deferred.ft.example", lease!);
  });

  it("does not overwrite a link that finished or already failed with a specific code", async () => {
    const saved = await save("https://specific.ft.example/page");
    await sql`update link set status = 'failed', fail_code = 'http_4xx' where id = ${saved.link.id}`;
    await run.giveUpFetch({ id: "x", kind: "fetch", key: saved.link.id, ownerId: owner.id, payload: {} }, "lease_expired");
    expect(await linkRow(saved.link.id)).toMatchObject({ status: "failed", fail_code: "http_4xx" });
    await sql`update link set status = 'extracted', fail_code = null where id = ${saved.link.id}`;
    await run.giveUpFetch({ id: "x", kind: "fetch", key: saved.link.id, ownerId: owner.id, payload: {} }, "lease_expired");
    expect(await linkRow(saved.link.id)).toMatchObject({ status: "extracted" });
  });

  it("runs one of two same-host jobs and spaces the other", async () => {
    const first = await save("https://spacing.ft.example/one");
    const second = await save("https://spacing.ft.example/two");
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const handler = run.createFetchHandler({
      fetch: async (input) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 200));
        active -= 1;
        calls += 1;
        return htmlResult(input);
      },
    });
    const ids = [(await jobFor(first.link.id)).id, (await jobFor(second.link.id)).id];
    await worker.createWorker({ handlers: { fetch: handler }, concurrency: 2 }).kick({ ids });
    expect(maxActive).toBe(1);
    expect(calls).toBe(1);
    const states = await Promise.all([jobFor(first.link.id), jobFor(second.link.id)]);
    const done = states.find((row) => row.status === "done");
    const waiting = states.find((row) => row.status === "queued");
    expect(done).toBeTruthy();
    expect(waiting?.last_error).toBe("host_busy");
    expect(Number(waiting?.deferrals)).toBe(1);
    expect(Number(waiting?.in_secs)).toBeGreaterThan(3);
    expect(Number(waiting?.in_secs)).toBeLessThanOrEqual(5);

    const [gap] = await sql<{ secs: number }[]>`
      select extract(epoch from (next_allowed_at - now())) as secs from fetch_host where host = 'spacing.ft.example'
    `;
    expect(Number(gap.secs)).toBeGreaterThan(0);
    expect(Number(gap.secs)).toBeLessThanOrEqual(2.5);

    await sql`update job set run_after = now() - interval '1 second' where id = ${waiting!.id}`;
    await worker.createWorker({ handlers: { fetch: handler }, concurrency: 2 }).kick({ ids: [waiting!.id] });
    expect(calls).toBe(1);

    await sql`update fetch_host set next_allowed_at = now() - interval '1 second', in_flight = false where host = 'spacing.ft.example'`;
    await sql`update job set run_after = now() - interval '1 second' where id = ${waiting!.id}`;
    await worker.createWorker({ handlers: { fetch: handler }, concurrency: 2 }).kick({ ids: [waiting!.id] });
    expect(calls).toBe(2);
    expect((await jobFor(first.link.id)).status).toBe("done");
    expect((await jobFor(second.link.id)).status).toBe("done");
  });

  it("does not let a stale release clear a newer host claim", async () => {
    const first = await host.claimHost("fence.ft.example");
    expect(first).toBeTruthy();
    await sql`update fetch_host set next_allowed_at = now() - interval '1 second' where host = 'fence.ft.example'`;
    const second = await host.claimHost("fence.ft.example");
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    await host.releaseHost("fence.ft.example", first!);
    const [held] = await sql`select in_flight, extract(epoch from next_allowed_at)::text as lease from fetch_host where host = 'fence.ft.example'`;
    expect(held.in_flight).toBe(true);
    expect(held.lease).toBe(second);
    expect(await host.claimHost("fence.ft.example")).toBeNull();
    await host.releaseHost("fence.ft.example", second!);
    const [freed] = await sql`select in_flight from fetch_host where host = 'fence.ft.example'`;
    expect(freed.in_flight).toBe(false);
    // A release also starts the 2s gap, so the next claim waits until that time has passed.
    await sql`update fetch_host set next_allowed_at = now() - interval '1 second' where host = 'fence.ft.example'`;
    expect(await host.claimHost("fence.ft.example")).toBeTruthy();
  });

  it("defers when the daily fetch cap is full, and does not fetch", async () => {
    const [prev] = await sql<{ count: number }[]>`
      select count from daily_usage where day = (now() at time zone 'utc')::date and kind = 'fetch'
    `;
    const previous = prev ? Number(prev.count) : 0;
    try {
      await sql`
        insert into daily_usage (day, kind, count) values ((now() at time zone 'utc')::date, 'fetch', 2000)
        on conflict (day, kind) do update set count = 2000
      `;
      const saved = await save("https://cap.ft.example/page");
      let calls = 0;
      const handler = run.createFetchHandler({
        fetch: async (input) => {
          calls += 1;
          return htmlResult(input);
        },
      });
      const row = await jobFor(saved.link.id);
      await worker.createWorker({ handlers: { fetch: handler }, concurrency: 1 }).kick({ ids: [row.id] });
      expect(calls).toBe(0);
      const after = await jobFor(saved.link.id);
      expect(after.status).toBe("queued");
      expect(after.last_error).toBe("fetch_cap");
      expect(Number(after.deferrals)).toBe(1);
      const [link] = await sql`select status from link where id = ${saved.link.id}`;
      expect(link.status).toBe("queued");
    } finally {
      await sql`
        insert into daily_usage (day, kind, count) values ((now() at time zone 'utc')::date, 'fetch', ${previous})
        on conflict (day, kind) do update set count = ${previous}
      `;
    }
  });

  it("stores a bundled fixture without fetching", async () => {
    const { DEMO_SEARCH_URL } = await import("@/lib/links/fixtures");
    const saved = await save(DEMO_SEARCH_URL);
    expect(saved.link.status).toBe("ready");
    const [{ n }] = await sql`select count(*)::int as n from job where key = ${saved.link.id}`;
    expect(n).toBe(0);
  });
});
