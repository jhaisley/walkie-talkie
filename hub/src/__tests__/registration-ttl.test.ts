import { beforeAll, describe, expect, it } from "vitest";

// Route DB-backed module side effects to an in-memory DB on import, matching the other hub tests
// (auth.js pulls in db.js transitively).
process.env.WALKIE_TALKIE_DB_PATH = ":memory:";

let resolveRegistrationTtlMs: (env?: NodeJS.ProcessEnv) => number;

beforeAll(async () => {
  ({ resolveRegistrationTtlMs } = await import("../auth.js"));
});

const SEVEN_DAYS = 604_800_000;

describe("resolveRegistrationTtlMs", () => {
  it("defaults to 7 days when the env var is unset", () => {
    expect(resolveRegistrationTtlMs({})).toBe(SEVEN_DAYS);
  });

  it("defaults to 7 days when the env var is empty", () => {
    expect(resolveRegistrationTtlMs({ WALKIE_TALKIE_REGISTRATION_TTL_MS: "" })).toBe(SEVEN_DAYS);
  });

  it("parses an explicit value (e.g. 1h for a short-lived test fleet)", () => {
    expect(resolveRegistrationTtlMs({ WALKIE_TALKIE_REGISTRATION_TTL_MS: "3600000" })).toBe(3_600_000);
  });

  it("treats 0 as the disable sentinel (<= 0 skips pruning entirely)", () => {
    expect(resolveRegistrationTtlMs({ WALKIE_TALKIE_REGISTRATION_TTL_MS: "0" })).toBe(0);
  });

  it("passes through a negative value (also disables, <= 0)", () => {
    expect(resolveRegistrationTtlMs({ WALKIE_TALKIE_REGISTRATION_TTL_MS: "-1" })).toBe(-1);
  });

  it("falls back to the default on a non-numeric value", () => {
    expect(resolveRegistrationTtlMs({ WALKIE_TALKIE_REGISTRATION_TTL_MS: "abc" })).toBe(SEVEN_DAYS);
  });

  it("reads the real process.env by default", () => {
    // Not set in this suite's env -> default. Asserts the no-arg path works.
    expect(resolveRegistrationTtlMs()).toBe(SEVEN_DAYS);
  });
});
