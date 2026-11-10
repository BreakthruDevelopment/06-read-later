import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction, type Socket } from "node:net";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { isPublicIp } from "@/lib/ip-guard";

/**
 * SSRF-safe GET for user-supplied URLs.
 *
 * Checking a hostname and then fetching it is not safe: DNS can answer differently the second time (rebinding).
 * Every address is resolved once, all of them must be public, and the socket's `lookup` returns only that pinned
 * address — it does not resolve again. TLS SNI and the Host header still use the hostname. Also:
 * - http(s) only, ports 80/443 only (override with `allowedPorts`), no credentials in the URL;
 * - blocked names (`localhost`, `*.local`, `*.internal`, `*.azurecontainerapps.io`) and non-public IP literals
 *   are refused before any DNS or connection;
 * - redirects are followed by hand (max `maxRedirects`), and every hop is checked from scratch;
 * - the body is capped at `maxBytes`, counted after gzip/deflate/brotli decompression;
 * - one deadline, `timeoutMs`, covers every hop and the whole body. Optional `connectTimeoutMs` and
 *   `headersTimeoutMs` are tighter caps on those phases.
 * No cookies, authorization or proxy are ever used. Errors carry a fixed message and a `code` only, never the URL
 * or any response content.
 */
export type SafeFetchCode =
  | "bad_url"
  | "blocked"
  | "too_large"
  | "timeout"
  | "too_many_redirects"
  | "network"
  | "dns"
  | "bad_content_type";

export class SafeFetchError extends Error {
  constructor(readonly code: SafeFetchCode) {
    super(`safeFetch failed: ${code}`);
    this.name = "SafeFetchError";
  }
}

export type SafeFetchOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  /** Aborts the socket connect. Falls inside `timeoutMs`. */
  connectTimeoutMs?: number;
  /** Aborts while waiting for response headers, measured from connect. Falls inside `timeoutMs`. */
  headersTimeoutMs?: number;
  maxRedirects?: number;
  allowedPorts?: number[];
  headers?: Record<string, string>;
  /** When set, a final response whose media type is not listed fails before the body is read. */
  allowedContentTypes?: string[];
  signal?: AbortSignal;
};

export type SafeFetchResult = { status: number; url: string; headers: Record<string, string>; body: Buffer };

type Resolve = (hostname: string) => Promise<{ address: string; family: number }[]>;
export type Deps = { resolve?: Resolve; isPublic?: (address: string) => boolean };
type Pin = { address: string; family: 4 | 6 };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const BLOCKED_EXACT = new Set(["localhost", "local", "internal", "azurecontainerapps.io"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".azurecontainerapps.io"];

/** Build a fetcher. Tests inject `resolve`/`isPublic`; production code uses the exported `safeFetch`. */
export function createSafeFetch(deps: Deps = {}) {
  const isPublic = deps.isPublic ?? isPublicIp;
  const resolve: Resolve = deps.resolve ?? ((host) => dns.promises.lookup(host, { all: true, verbatim: true }));

  async function pinHost(host: string): Promise<Pin> {
    let addresses: { address: string; family: number }[];
    try {
      addresses = await resolve(host);
    } catch (err) {
      if (err instanceof SafeFetchError) throw err;
      throw new SafeFetchError("dns");
    }
    if (addresses.length === 0 || !addresses.every((item) => isPublic(item.address))) {
      throw new SafeFetchError("blocked");
    }
    const first = addresses[0];
    const family: 4 | 6 = first.family === 6 ? 6 : first.family === 4 ? 4 : first.address.includes(":") ? 6 : 4;
    return { address: first.address, family };
  }

  function hop(
    url: URL,
    headers: Record<string, string>,
    maxBytes: number,
    deadline: number,
    pin: Pin | null,
    allowedContentTypes: string[] | undefined,
    connectTimeoutMs: number | undefined,
    headersTimeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ) {
    return new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolveHop, reject) => {
      const lib = url.protocol === "https:" ? https : http;
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (fn: () => void) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const fail = (err: SafeFetchError) => done(() => reject(err));
      const arm = (ms: number) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          req.destroy();
          fail(new SafeFetchError("timeout"));
        }, Math.max(1, ms));
        timer.unref?.();
      };
      const onAbort = () => {
        req.destroy();
        fail(new SafeFetchError("timeout"));
      };

      const lookup: LookupFunction = (_hostname, options, callback) => {
        if (!pin) {
          callback(new SafeFetchError("blocked") as unknown as NodeJS.ErrnoException, "", 0);
          return;
        }
        const one = { address: pin.address, family: pin.family };
        if (typeof options === "object" && options.all) {
          (callback as unknown as (err: null, addresses: (typeof one)[]) => void)(null, [one]);
          return;
        }
        callback(null, pin.address, pin.family);
      };

      if (signal?.aborted) {
        reject(new SafeFetchError("timeout"));
        return;
      }

      const req = lib.request(
        url,
        {
          method: "GET",
          headers: { "user-agent": "30-apps-safe-fetch", accept: "*/*", ...headers },
          ...(pin ? { lookup } : {}),
          agent: false,
        },
        (res) => {
          arm(Math.max(1, deadline - Date.now()));
          const status = res.statusCode ?? 0;
          const out: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined) out[key] = Array.isArray(value) ? value.join(", ") : value;
          }
          const stop = () => {
            res.on("error", () => {});
            res.destroy();
            req.destroy();
          };
          if (REDIRECTS.has(status)) {
            stop();
            return done(() => resolveHop({ status, headers: out, body: Buffer.alloc(0) }));
          }
          if (allowedContentTypes && !allowedContentTypes.includes(mediaType(out["content-type"]))) {
            stop();
            return fail(new SafeFetchError("bad_content_type"));
          }
          const encoding = (out["content-encoding"] ?? "").trim().toLowerCase();
          const compressed = encoding !== "" && encoding !== "identity";
          const declared = Number(out["content-length"]);
          if (!compressed && Number.isFinite(declared) && declared > maxBytes) {
            stop();
            return fail(new SafeFetchError("too_large"));
          }
          const decoded = decodedBody(res, encoding);
          const chunks: Buffer[] = [];
          let total = 0;
          // Attach the error handler before reading. Destroying an over-cap stream emits `error` synchronously,
          // and that must not replace the too_large result or escape as an unhandled rejection.
          const onStreamError = () => fail(new SafeFetchError("network"));
          decoded.on("error", onStreamError);
          if (decoded !== res) res.on("error", onStreamError);
          res.on("aborted", onStreamError);
          decoded.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
              fail(new SafeFetchError("too_large"));
              decoded.destroy();
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          decoded.on("end", () => done(() => resolveHop({ status, headers: out, body: Buffer.concat(chunks) })));
        },
      );

      const remaining = Math.max(1, deadline - Date.now());
      arm(connectTimeoutMs !== undefined ? Math.min(connectTimeoutMs, remaining) : remaining);
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("socket", (socket: Socket) => {
        if (connectTimeoutMs === undefined && headersTimeoutMs === undefined) return;
        const onConnect = () => {
          const left = Math.max(1, deadline - Date.now());
          arm(headersTimeoutMs !== undefined ? Math.min(headersTimeoutMs, left) : left);
        };
        if (socket.connecting) socket.once("connect", onConnect);
        else onConnect();
      });
      req.on("error", (err) => fail(err instanceof SafeFetchError ? err : new SafeFetchError("network")));
      req.end();
    });
  }

  return async function safeFetch(input: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
    const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
    const maxRedirects = opts.maxRedirects ?? 3;
    const ports = opts.allowedPorts ?? [80, 443];
    const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
    if (opts.signal?.aborted) throw new SafeFetchError("timeout");

    let url = parse(input);
    for (let redirects = 0; ; redirects++) {
      if (opts.signal?.aborted) throw new SafeFetchError("timeout");
      const host = bareHost(url);
      vet(url, host, ports, isPublic);
      const pin = isIP(host) ? null : await pinHost(host);
      const res = await hop(
        url,
        opts.headers ?? {},
        maxBytes,
        deadline,
        pin,
        opts.allowedContentTypes,
        opts.connectTimeoutMs,
        opts.headersTimeoutMs,
        opts.signal,
      );
      const location = res.headers.location;
      if (!REDIRECTS.has(res.status) || !location) return { ...res, url: url.toString() };
      if (redirects >= maxRedirects) throw new SafeFetchError("too_many_redirects");
      url = parse(location, url);
    }
  };
}

function parse(input: string, base?: URL): URL {
  try {
    return new URL(input, base);
  } catch {
    throw new SafeFetchError("bad_url");
  }
}

function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
}

function isBlockedName(host: string): boolean {
  if (BLOCKED_EXACT.has(host)) return true;
  return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function vet(url: URL, host: string, ports: number[], isPublic: (address: string) => boolean): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SafeFetchError("bad_url");
  if (url.username || url.password) throw new SafeFetchError("bad_url");
  if (!host) throw new SafeFetchError("bad_url");
  if (host.length > 253) throw new SafeFetchError("bad_url");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!ports.includes(port)) throw new SafeFetchError("blocked");
  if (isBlockedName(host)) throw new SafeFetchError("blocked");
  // IP literals skip DNS, so vet them here. WHATWG URL already turns 2130706433 or 0x7f.1 into 127.0.0.1.
  if (isIP(host) && !isPublic(host)) throw new SafeFetchError("blocked");
}

function mediaType(header: string | undefined): string {
  if (!header) return "";
  return header.split(";", 1)[0]?.split(",", 1)[0]?.trim().toLowerCase() ?? "";
}

/** Inflate a single known encoding. Anything else is read raw and still capped, so an unknown encoding cannot expand. */
function decodedBody(res: http.IncomingMessage, encoding: string): Readable {
  if (encoding === "" || encoding === "identity" || encoding.includes(",")) return res;
  if (encoding === "gzip" || encoding === "x-gzip") return res.pipe(zlib.createGunzip());
  if (encoding === "deflate") return res.pipe(zlib.createInflate());
  if (encoding === "br") return res.pipe(zlib.createBrotliDecompress());
  return res;
}

export const safeFetch = createSafeFetch();
