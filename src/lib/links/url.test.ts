import { describe, expect, it } from "vitest";
import { normalizeUrl } from "./url";

describe("normalizeUrl", () => {
  it("lowercases the host, drops the fragment and tracking params, and matches a clean URL", () => {
    const dirty = normalizeUrl("HTTPS://Example.COM/a/b?utm_source=x&b=1&fbclid=abc&gclid=q#section");
    const clean = normalizeUrl("https://example.com/a/b?b=1");
    expect(dirty).toEqual(clean);
    expect(dirty.url).toBe("https://example.com/a/b?b=1");
    expect(dirty.host).toBe("example.com");
    expect(dirty.urlHash).toHaveLength(64);
  });

  it("sorts query params so the same link saved two ways is one row", () => {
    expect(normalizeUrl("https://example.com/a?b=1&a=2").urlHash).toBe(normalizeUrl("https://example.com/a?a=2&b=1").urlHash);
  });

  it("strips a default port and keeps an explicit path", () => {
    expect(normalizeUrl("https://example.com:443/x").url).toBe("https://example.com/x");
    expect(normalizeUrl("http://example.com:80").url).toBe("http://example.com/");
  });

  it("stores international names as punycode", () => {
    expect(normalizeUrl("https://münchen.de/a").host).toBe("xn--mnchen-3ya.de");
  });

  it("rejects non-http schemes, userinfo, odd ports, and over-long input", () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "ftp://example.com/a", "https://user:pass@example.com/a", "https://example.com:8443/a", "not a url"]) {
      expect(() => normalizeUrl(url)).toThrow(/URL|port|username/i);
    }
    expect(() => normalizeUrl(`https://example.com/${"a".repeat(2100)}`)).toThrow(/too long/i);
  });

  it("rejects literal blocked hosts and private addresses", () => {
    for (const url of [
      "http://localhost/admin",
      "http://foo.localhost/a",
      "http://printer.local/a",
      "http://db.internal/a",
      "https://app.azurecontainerapps.io/a",
      "http://127.0.0.1/",
      "http://10.1.2.3/a",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://169.254.169.254/metadata",
      "http://168.63.129.16/",
      "http://[::1]/",
      "http://[fc00::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://0.0.0.0/",
      "http://2130706433/",
      "http://0177.0.0.1/",
    ]) {
      expect(() => normalizeUrl(url), url).toThrow(/can't be saved/);
    }
  });

  it("allows a public address", () => {
    expect(normalizeUrl("https://1.1.1.1/dns").host).toBe("1.1.1.1");
  });
});
