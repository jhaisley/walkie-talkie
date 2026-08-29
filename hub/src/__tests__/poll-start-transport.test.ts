import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.WALKIE_TALKIE_DB_PATH = ":memory:";
const { initDB } = await import("../db.js");
const { registerUser, unregisterUser } = await import("../auth.js");
const { ensureQueue } = await import("../router.js");
const { awaitPoll, addPoll, resetPollingState } = await import("../polling.js");

/**
 * [poll-start] is emitted from the ONE function both transports share, so without a tag it is
 * a liveness signal, not a transport signal. During the JDESK cutover it was read as the latter
 * and produced a false "five stations still on stdio" verdict against live hosted sessions.
 * These tests pin that the two transports are distinguishable in the log.
 */
describe("[poll-start] names its transport", () => {
  let logs: string[];
  beforeEach(() => {
    initDB();
    resetPollingState();
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tags a hub-hosted in-process wait as :hosted", async () => {
    registerUser("hosted-station");
    ensureQueue("hosted-station");
    const p = awaitPoll("hosted-station", undefined, 50);
    await p;
    expect(logs.some((l) => l.startsWith("[poll-start:hosted] hosted-station"))).toBe(true);
    expect(logs.some((l) => l.startsWith("[poll-start] hosted-station"))).toBe(false);
    unregisterUser("hosted-station");
  });

  it("leaves an HTTP long-poll untagged, so existing log readers keep working", async () => {
    registerUser("http-station");
    ensureQueue("http-station");
    const { EventEmitter } = await import("node:events");
    const req = new EventEmitter() as unknown as import("node:http").IncomingMessage;
    const res = {
      writableEnded: false,
      writeHead() {},
      end() {
        (res as { writableEnded: boolean }).writableEnded = true;
      },
    } as unknown as import("node:http").ServerResponse;
    addPoll("http-station", req, res, undefined, 50);
    await new Promise((r) => setTimeout(r, 80));
    expect(logs.some((l) => l.startsWith("[poll-start] http-station"))).toBe(true);
    expect(logs.some((l) => l.includes(":hosted] http-station"))).toBe(false);
    unregisterUser("http-station");
  });
});
