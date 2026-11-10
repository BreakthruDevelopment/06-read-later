import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FETCH_USER_AGENT, readFetchedPage } from "@/lib/fetch/page";
import { createSafeFetch, safeFetch, SafeFetchError } from "@/lib/safe-fetch";

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof SafeFetchError ? e.code : `other:${String(e)}`));

describe("safeFetch (real guard, no network needed)", () => {
  it.each([
    "http://127.0.0.1/",
    "http://127.0.0.1:80/",
    "http://[::1]/",
    "http://10.0.0.5/",
    "http://169.254.169.254/latest/meta-data/",
    "http://168.63.129.16/",
    "http://2130706433/", // decimal loopback
    "http://0x7f.1/", // hex loopback
    "http://[::ffff:127.0.0.1]/",
    "https://[fd00::1]/",
  ])("refuses the literal %s before connecting", async (url) => {
    expect(await code(safeFetch(url))).toBe("blocked");
  });

  it("refuses a hostname that resolves to loopback", async () => {
    expect(await code(safeFetch("http://localhost/"))).toBe("blocked");
  });

  it.each([
    "http://localhost/",
    "http://foo.localhost/",
    "http://foo.local/",
    "http://bar.internal/",
    "http://app.azurecontainerapps.io/",
    "http://localhost./",
  ])("refuses the blocked name %s before any connection", async (url) => {
    expect(await code(safeFetch(url))).toBe("blocked");
  });

  it.each([
    ["0.0.0.0", 4],
    ["10.1.2.3", 4],
    ["100.64.0.1", 4],
    ["100.127.255.255", 4],
    ["127.0.0.1", 4],
    ["169.254.169.254", 4],
    ["172.16.0.1", 4],
    ["172.31.255.255", 4],
    ["192.0.0.8", 4],
    ["192.0.2.1", 4],
    ["192.88.99.1", 4],
    ["192.168.1.1", 4],
    ["198.18.0.1", 4],
    ["198.19.255.1", 4],
    ["198.51.100.1", 4],
    ["203.0.113.1", 4],
    ["224.0.0.1", 4],
    ["240.0.0.1", 4],
    ["255.255.255.255", 4],
    ["168.63.129.16", 4],
    ["::", 6],
    ["::1", 6],
    ["fc00::1", 6],
    ["fd12:3456::1", 6],
    ["fe80::1", 6],
    ["ff02::1", 6],
    ["::ffff:127.0.0.1", 6],
    ["::ffff:169.254.169.254", 6],
    ["::ffff:10.0.0.1", 6],
    ["64:ff9b::7f00:1", 6],
    ["2002:7f00:1::", 6],
    ["2002:a9fe:a9fe::", 6],
    ["2001:db8::1", 6],
  ] as const)("a stub resolver returning %s is blocked", async (address, family) => {
    const fetcher = createSafeFetch({ resolve: async () => [{ address, family }] });
    expect(await code(fetcher(`http://blocked.test/${address}`))).toBe("blocked");
  });

  it.each(["ftp://example.com/", "file:///etc/passwd", "not a url", "http://user:pw@example.com/", "http:///"])("rejects %s", async (url) => {
    expect(await code(safeFetch(url))).toBe("bad_url");
  });

  it("refuses ports other than 80 and 443", async () => {
    expect(await code(safeFetch("http://93.184.216.34:6379/"))).toBe("blocked");
  });
});

describe("safeFetch (guard against a local server)", () => {
  let server: http.Server;
  let base: string;
  const hits: string[] = [];
  const agents: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      agents.push(String(req.headers["user-agent"] ?? ""));
      const url = req.url ?? "";
      if (url.split("?")[0] === "/png") {
        res.writeHead(200, { "content-type": "image/png" });
        return void res.end("not-an-image");
      }
      if (url === "/gzip") {
        const raw = Buffer.from("z".repeat(8_000));
        const gz = zlib.gzipSync(raw);
        res.writeHead(200, {
          "content-type": "text/plain",
          "content-encoding": "gzip",
          "content-length": String(gz.length),
        });
        return void res.end(gz);
      }
      if (url === "/ok") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        return void res.end("hello");
      }
      if (url === "/big") return void res.end("x".repeat(5000));
      if (url === "/big-stream") {
        res.write("x".repeat(3000));
        return void res.write("y".repeat(3000)); // never ends, and has no Content-Length
      }
      if (url === "/hang") return;
      if (url === "/r1") return void res.writeHead(302, { location: "/r2" }).end();
      if (url === "/r2") return void res.writeHead(302, { location: "/ok" }).end();
      if (url === "/loop") return void res.writeHead(302, { location: "/loop" }).end();
      if (url === "/to-private") return void res.writeHead(302, { location: "http://10.1.2.3/secret" }).end();
      if (url === "/to-meta-host") return void res.writeHead(302, { location: "http://meta.test/" }).end();
      if (url === "/to-imds") return void res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
      if (url === "/to-internal") return void res.writeHead(302, { location: "http://db.internal/secret" }).end();
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://public.test:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  // "public.test" resolves to the local server; "meta.test" resolves to a private address. Only 127.0.0.1 counts as public here.
  const fetcher = createSafeFetch({
    resolve: async (host) => (host === "meta.test" ? [{ address: "10.9.9.9", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]),
    isPublic: (a) => a === "127.0.0.1",
  });
  const opts = () => ({ allowedPorts: [Number(new URL(base).port)] });

  it("returns status, headers and body", async () => {
    const res = await fetcher(`${base}/ok`, opts());
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("hello");
    expect(res.url).toBe(`${base}/ok`);
  });

  it("follows redirects by hand up to the limit", async () => {
    expect((await fetcher(`${base}/r1`, opts())).body.toString()).toBe("hello");
    expect(await code(fetcher(`${base}/loop`, { ...opts(), maxRedirects: 3 }))).toBe("too_many_redirects");
  });

  it("re-checks every hop: a redirect to a private literal or to a host that resolves privately is refused", async () => {
    const wide = { ...opts(), allowedPorts: [80, Number(new URL(base).port)] };
    expect(await code(fetcher(`${base}/to-private`, wide))).toBe("blocked");
    expect(hits).not.toContain("/secret");
    expect(await code(fetcher(`${base}/to-meta-host`, wide))).toBe("blocked");
    expect(await code(fetcher(`${base}/to-imds`, wide))).toBe("blocked");
    expect(hits).not.toContain("/latest/meta-data/");
    expect(await code(fetcher(`${base}/to-internal`, wide))).toBe("blocked");
  });

  it("pins the first answer: a later resolve that turns private is never connected to", async () => {
    let calls = 0;
    const pinned = createSafeFetch({
      resolve: async () => {
        calls += 1;
        return calls === 1 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.9.9.9", family: 4 }];
      },
      isPublic: (address) => address === "127.0.0.1",
    });
    const before = hits.length;
    const res = await pinned(`${base}/ok`, opts());
    expect(res.body.toString()).toBe("hello");
    expect(calls).toBe(1);
    expect(hits.length).toBe(before + 1);
  });

  it("does not connect when any resolved address is private", async () => {
    const mixed = createSafeFetch({
      resolve: async () => [
        { address: "127.0.0.1", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
      isPublic: (address) => address === "127.0.0.1",
    });
    const before = hits.length;
    expect(await code(mixed(`${base}/ok`, opts()))).toBe("blocked");
    expect(hits.length).toBe(before);
  });

  it("refuses a name that resolves to a private address, and one with a mix of public and private answers", async () => {
    expect(await code(createSafeFetch({ resolve: async () => [{ address: "10.0.0.1", family: 4 }] })("http://rebind.test/"))).toBe("blocked");
    const mixed = createSafeFetch({ resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }] });
    expect(await code(mixed("http://mixed.test/"))).toBe("blocked");
  });

  it("caps the body, by Content-Length and by counting a stream", async () => {
    expect(await code(fetcher(`${base}/big`, { ...opts(), maxBytes: 1000 }))).toBe("too_large");
    expect(await code(fetcher(`${base}/big-stream`, { ...opts(), maxBytes: 4000 }))).toBe("too_large");
    expect((await fetcher(`${base}/big`, { ...opts(), maxBytes: 5000 })).body.length).toBe(5000);
  });

  it("times out on a server that never answers", async () => {
    expect(await code(fetcher(`${base}/hang`, { ...opts(), timeoutMs: 200 }))).toBe("timeout");
  });

  it("times out while waiting for headers, inside the overall deadline", async () => {
    const started = Date.now();
    expect(await code(fetcher(`${base}/hang`, { ...opts(), timeoutMs: 5_000, headersTimeoutMs: 150 }))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("aborts when the caller signal aborts", async () => {
    const controller = new AbortController();
    const pending = fetcher(`${base}/hang`, { ...opts(), timeoutMs: 5_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    expect(await code(pending)).toBe("timeout");
  });

  it("refuses a content type that is not text, before keeping the body", async () => {
    expect(await code(fetcher(`${base}/png`, { ...opts(), allowedContentTypes: ["text/html", "text/plain"] }))).toBe("bad_content_type");
  });

  it("caps a gzip body by the size after decompression", async () => {
    expect(await code(fetcher(`${base}/gzip`, { ...opts(), maxBytes: 1_000 }))).toBe("too_large");
    const res = await fetcher(`${base}/gzip`, { ...opts(), maxBytes: 20_000 });
    expect(res.body.toString()).toBe("z".repeat(8_000));
  });

  it("errors never contain the URL", async () => {
    const err = await fetcher(`${base}/big?token=secret-canary`, { ...opts(), maxBytes: 10 }).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain("secret-canary");
    const typeErr = await fetcher(`${base}/png?token=secret-canary`, {
      ...opts(),
      allowedContentTypes: ["text/html"],
    }).catch((e: Error) => e);
    expect(String((typeErr as Error).message)).not.toContain("secret-canary");
    expect((typeErr as SafeFetchError).code).toBe("bad_content_type");
  });

  it("sends the read-later user agent and accepts an html page", async () => {
    const before = agents.length;
    const page = await readFetchedPage(`${base}/ok`, new AbortController().signal, {
      fetch: fetcher,
      allowedPorts: [Number(new URL(base).port)],
    });
    expect(page.status).toBe(200);
    expect(page.html).toBe("hello");
    expect(agents[before]).toBe(FETCH_USER_AGENT);
    expect(page.finalUrl).toBe(`${base}/ok`);
  });
});

describe("safeFetch (DNS bound, teardown, status before content type)", () => {
  let server: http.Server;
  let base: string;
  const closed = new Set<string>();
  const sockets = new Set<string>();

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? "";
      sockets.add(url);
      res.on("close", () => closed.add(url));
      if (url === "/bad-gzip") {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        return void res.write(Buffer.from("this is not gzip data at all, just plain bytes"));
      }
      if (url === "/never-ends") {
        res.writeHead(200, { "content-type": "text/plain" });
        return void res.write("x".repeat(100));
      }
      if (url === "/stalls-after-headers" || url === "/stalls-abort") {
        res.writeHead(200, { "content-type": "text/plain" });
        return void res.flushHeaders();
      }
      if (url === "/raw-heavy") {
        // Incompressible bytes in stored blocks: ~1,013 bytes on the wire, 990 after inflating, no Content-Length.
        const stored = zlib.gzipSync(Buffer.from(Array.from({ length: 990 }, (_, i) => (i * 37 + 11) % 251)), { level: 0 });
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        res.write(stored.subarray(0, 500));
        return void setTimeout(() => res.end(stored.subarray(500)), 20);
      }
      if (url.startsWith("/status/")) {
        const status = Number(url.slice("/status/".length));
        res.writeHead(status, { "content-type": "application/json" });
        return void res.end('{"error":"nope"}');
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://public.test:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const fetcher = createSafeFetch({
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    isPublic: (a) => a === "127.0.0.1",
  });
  const opts = () => ({ allowedPorts: [Number(new URL(base).port)] });
  const waitClosed = async (path: string) => {
    for (let i = 0; i < 100 && !closed.has(path); i++) await new Promise((r) => setTimeout(r, 20));
    return closed.has(path);
  };

  it("a resolver that never answers fails with timeout at the deadline", async () => {
    const hung = createSafeFetch({ resolve: () => new Promise(() => {}) });
    const started = Date.now();
    expect(await code(hung("http://slow-dns.test/", { timeoutMs: 150 }))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("a resolver that never answers stops when the caller signal aborts, and an already-aborted signal never resolves", async () => {
    const hung = createSafeFetch({ resolve: () => new Promise(() => {}) });
    const controller = new AbortController();
    const pending = hung("http://slow-dns.test/", { timeoutMs: 30_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    expect(await code(pending)).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(await code(hung("http://slow-dns.test/", { signal: AbortSignal.abort() }))).toBe("timeout");
  });

  it("a resolver that rejects late still maps to dns, and a late rejection after the deadline is not unhandled", async () => {
    const failing = createSafeFetch({ resolve: async () => Promise.reject(new Error("ENOTFOUND")) });
    expect(await code(failing("http://nx.test/"))).toBe("dns");
    const late = createSafeFetch({ resolve: () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 120)) });
    expect(await code(late("http://late.test/", { timeoutMs: 40 }))).toBe("timeout");
    await new Promise((r) => setTimeout(r, 200));
  });

  it("closes the connection when decompression fails", async () => {
    expect(await code(fetcher(`${base}/bad-gzip`, opts()))).toBe("network");
    expect(await waitClosed("/bad-gzip")).toBe(true);
  });

  it("closes the connection on the size cap, on a timeout after headers, and on abort", async () => {
    expect(await code(fetcher(`${base}/never-ends`, { ...opts(), maxBytes: 50 }))).toBe("too_large");
    expect(await waitClosed("/never-ends")).toBe(true);

    expect(await code(fetcher(`${base}/stalls-after-headers`, { ...opts(), timeoutMs: 200 }))).toBe("timeout");
    expect(await waitClosed("/stalls-after-headers")).toBe(true);

    const controller = new AbortController();
    const pending = fetcher(`${base}/stalls-abort`, { ...opts(), timeoutMs: 10_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect(await code(pending)).toBe("timeout");
    expect(await waitClosed("/stalls-abort")).toBe(true);
  });

  it("caps the compressed bytes on the wire as well as the decompressed size", async () => {
    expect(await code(fetcher(`${base}/raw-heavy`, { ...opts(), maxBytes: 1_000 }))).toBe("too_large");
    const res = await fetcher(`${base}/raw-heavy`, { ...opts(), maxBytes: 2_000 });
    expect(res.body.length).toBe(990);
  });

  it.each([429, 500, 502, 503, 404])("judges status %i before the content type", async (status) => {
    const res = await fetcher(`${base}/status/${status}`, { ...opts(), allowedContentTypes: ["text/html", "text/plain"] });
    expect(res.status).toBe(status);
    expect(res.body.length).toBe(0);
  });

  it("a 200 of the wrong type is still bad_content_type", async () => {
    // Same JSON body, but success: handled by the existing /png case; here confirm a 2xx JSON is refused too.
    const ok = createSafeFetch({ resolve: async () => [{ address: "127.0.0.1", family: 4 }], isPublic: () => true });
    const s2 = http.createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
    await new Promise<void>((r) => s2.listen(0, "127.0.0.1", r));
    try {
      const port = (s2.address() as AddressInfo).port;
      expect(await code(ok(`http://j.test:${port}/`, { allowedPorts: [port], allowedContentTypes: ["text/html"] }))).toBe("bad_content_type");
    } finally {
      s2.close();
    }
  });
});
