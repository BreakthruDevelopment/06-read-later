import type { LinkStatus as DbStatus } from "@/lib/db/schema";
import { describe, expect, it } from "vitest";
import {
  LINK_STATUSES,
  STATUS_POLL_BUDGET_MS,
  STATUS_POLL_MS,
  bookmarkletHref,
  failLabel,
  invalidTag,
  oneString,
  parseTagList,
  readingMinutes,
  safeNext,
  statusPresentation,
  type LinkStatus,
} from "./reader-format";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const statusTypesMatch: Equal<LinkStatus, DbStatus> = true;

describe("reader format", () => {
  it("keeps the status union aligned with the database", () => {
    expect(statusTypesMatch).toBe(true);
    expect(LINK_STATUSES).toEqual(["queued", "fetching", "extracted", "summarizing", "ready", "failed"]);
  });

  it("polls unfinished links every 3 seconds for at most 2 minutes", () => {
    expect(STATUS_POLL_MS).toBe(3_000);
    expect(STATUS_POLL_BUDGET_MS).toBe(120_000);
  });

  it("rounds reading time to minutes", () => {
    expect(readingMinutes(null)).toBeNull();
    expect(readingMinutes(0)).toBeNull();
    expect(readingMinutes(40)).toBe(1);
    expect(readingMinutes(200)).toBe(1);
    expect(readingMinutes(300)).toBe(2);
  });

  it("names fail codes and status chips", () => {
    expect(failLabel("no_text")).toBe("Couldn't extract readable text.");
    expect(failLabel(null)).toBeNull();
    expect(failLabel("mystery")).toBe("The page couldn't be fetched.");
    expect(statusPresentation("queued", false)).toEqual({ tone: "building", label: "Queued" });
    expect(statusPresentation("queued", true).label).toBe("Finishes next time you open the app");
    expect(statusPresentation("failed", true).label).toBe("Failed");
    expect(statusPresentation("ready", false).tone).toBe("live");
  });

  it("accepts only an in-app return path", () => {
    expect(safeNext(undefined)).toBe("/inbox");
    expect(safeNext("/settings")).toBe("/settings");
    expect(safeNext("/save?url=https://example.com/a")).toBe("/save?url=https://example.com/a");
    expect(safeNext("https://evil.example")).toBe("/inbox");
    expect(safeNext("//evil.example")).toBe("/inbox");
    expect(safeNext("/\\evil")).toBe("/inbox");
    expect(safeNext("/%2f%2fevil.example")).toBe("/inbox");
    expect(oneString(["  tags  ", "other"])).toBe("tags");
    expect(oneString("   ")).toBeUndefined();
  });

  it("parses tag boxes and builds the bookmarklet", () => {
    expect(parseTagList(" Postgres, databases  postgres ")).toEqual(["postgres", "databases"]);
    expect(invalidTag("postgres")).toBe(false);
    expect(invalidTag("No Spaces")).toBe(true);
    expect(bookmarkletHref("https://app6.breakthruventures.ai/")).toBe(
      "javascript:location.href='https://app6.breakthruventures.ai/save?url='+encodeURIComponent(location.href)",
    );
    expect(bookmarkletHref("https://evil.example/'")).toBeNull();
  });
});
