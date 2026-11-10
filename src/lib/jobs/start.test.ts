import { afterEach, describe, expect, it, vi } from "vitest";

const startWorker = vi.fn();

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("./handlers");
  startWorker.mockClear();
});

async function load(handlers: Record<string, unknown>, onGiveUp: Record<string, unknown> = {}) {
  vi.doMock("./worker", () => ({ startWorker }));
  vi.doMock("./handlers", () => ({ handlers, onGiveUp }));
  return (await import("./start")).startJobs();
}

describe("startJobs (called from instrumentation.ts)", () => {
  it("starts no worker when no handlers are registered", async () => {
    expect(await load({})).toBe(false);
    expect(startWorker).not.toHaveBeenCalled();
  });

  it("starts the worker with the registered handlers", async () => {
    const handler = async () => {};
    const hook = async () => {};
    expect(await load({ "fetch-link": handler }, { "fetch-link": hook })).toBe(true);
    expect(startWorker).toHaveBeenCalledWith({ handlers: { "fetch-link": handler }, onGiveUp: { "fetch-link": hook } });
  });
});
