import { beforeAll, describe, expect, it } from "vitest";

// Route DB-backed module side effects to an in-memory DB on import, matching the
// other hub tests (polling.js pulls in db-touching modules transitively).
process.env.WALKIE_TALKIE_DB_PATH = ":memory:";

let resolvePollTimeoutMs: (env?: NodeJS.ProcessEnv) => number;

beforeAll(async () => {
  ({ resolvePollTimeoutMs } = await import("../polling.js"));
});

describe("resolvePollTimeoutMs", () => {
  it("defaults to 25s when the env var is unset", () => {
    expect(resolvePollTimeoutMs({})).toBe(25_000);
  });

  it("defaults to 25s when the env var is empty", () => {
    expect(resolvePollTimeoutMs({ WALKIE_TALKIE_POLL_TIMEOUT_MS: "" })).toBe(25_000);
  });

  it("parses an explicit override", () => {
    expect(resolvePollTimeoutMs({ WALKIE_TALKIE_POLL_TIMEOUT_MS: "10000" })).toBe(10_000);
  });

  it("falls back to the default on a non-numeric value", () => {
    expect(resolvePollTimeoutMs({ WALKIE_TALKIE_POLL_TIMEOUT_MS: "abc" })).toBe(25_000);
  });

  it("falls back to the default on 0 (a zero timeout would answer instantly)", () => {
    expect(resolvePollTimeoutMs({ WALKIE_TALKIE_POLL_TIMEOUT_MS: "0" })).toBe(25_000);
  });

  it("falls back to the default on a negative value", () => {
    expect(resolvePollTimeoutMs({ WALKIE_TALKIE_POLL_TIMEOUT_MS: "-1" })).toBe(25_000);
  });

  it("reads the real process.env by default", () => {
    // Not set in this suite's env -> default. Asserts the no-arg path works.
    expect(resolvePollTimeoutMs()).toBe(25_000);
  });

  it("stays below the MCP client's 30s poll abort (the ordering constraint)", () => {
    // If this ever fails, the client aborts first, req.on("close") fires while
    // the poll is pending, and every idle standby arms a stale-grace reap.
    const MCP_CLIENT_POLL_TIMEOUT_MS = 30_000;
    expect(resolvePollTimeoutMs({})).toBeLessThan(MCP_CLIENT_POLL_TIMEOUT_MS);
  });
});
