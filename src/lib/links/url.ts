import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { BadRequestError } from "@/lib/errors";
import { isPublicIp } from "@/lib/ip-guard";

const MAX_URL = 2048;
const MAX_HOST = 253;

export type NormalizedUrl = { url: string; urlHash: string; host: string };

/**
 * Canonical form: lowercase punycode host, no fragment, no default port, tracking params removed.
 * Rejects anything the fetcher would refuse for the URL itself (scheme, port, userinfo, literal blocked hosts).
 * DNS checks happen at fetch time.
 */
export function normalizeUrl(raw: unknown): NormalizedUrl {
  if (typeof raw !== "string") throw new BadRequestError("Enter an http or https URL.");
  const trimmed = raw.trim();
  if (!trimmed) throw new BadRequestError("Enter an http or https URL.");
  if (trimmed.length > MAX_URL) throw new BadRequestError("URL is too long.");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BadRequestError("Enter an http or https URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BadRequestError("Enter an http or https URL.");
  }
  if (parsed.username || parsed.password) {
    throw new BadRequestError("URLs with a username or password can't be saved.");
  }
  if (parsed.port && !((parsed.protocol === "http:" && parsed.port === "80") || (parsed.protocol === "https:" && parsed.port === "443"))) {
    throw new BadRequestError("Only ports 80 and 443 can be saved.");
  }
  parsed.port = "";
  parsed.hash = "";

  // Node reports an IPv6 hostname with brackets (`[::1]`). The address check needs the bare form.
  const host = bareHost(parsed.hostname);
  if (!host || host.length > MAX_HOST || isBlockedHost(host)) {
    throw new BadRequestError("That address can't be saved.");
  }
  parsed.hostname = host;

  // The stored (and later fetched) URL keeps its original query order and encoding; only tracking params go.
  // Duplicate detection hashes a separate form with the params sorted and re-serialized.
  const original = parsed.search ? parsed.search.slice(1).split("&") : [];
  const keptRaw = original.filter((pair) => pair && !isTracking(safeDecode(pair.split("=")[0])));
  parsed.search = keptRaw.join("&");
  const url = parsed.href;
  if (url.length > MAX_URL) throw new BadRequestError("URL is too long.");

  const hashed = new URL(url);
  const kept = [...hashed.searchParams.entries()];
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  hashed.search = "";
  for (const [key, value] of kept) hashed.searchParams.append(key, value);
  return { url, urlHash: createHash("sha256").update(hashed.href).digest("hex"), host };
}

function bareHost(hostname: string): string {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return bare.toLowerCase().replace(/\.+$/, "");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function isTracking(key: string): boolean {
  const name = key.toLowerCase();
  return name.startsWith("utm_") || name === "fbclid" || name === "gclid";
}

function isBlockedHost(host: string): boolean {
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "local" ||
    host.endsWith(".local") ||
    host === "internal" ||
    host.endsWith(".internal") ||
    host === "azurecontainerapps.io" ||
    host.endsWith(".azurecontainerapps.io")
  ) {
    return true;
  }
  return isIP(host) !== 0 && !isPublicIp(host);
}
