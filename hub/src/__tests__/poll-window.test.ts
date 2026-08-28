import { describe, expect, it } from "vitest";
import { resolveMaxPollWindowMs, resolvePollWindowMs } from "../polling.js";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("client-requested poll window", () => {
  it("falls back to the hub default when absent or unusable", () => {
    const d = resolvePollWindowMs(null, env({}));
    for (const bad of ["", "abc", "-1", "0"]) {
      expect(resolvePollWindowMs(bad, env({}))).toBe(d);
    }
  });

  it("honours a requested window", () => {
    expect(resolvePollWindowMs("120000", env({}))).toBe(120_000);
  });

  it("clamps above the ceiling so a client cannot park a socket indefinitely", () => {
    const max = resolveMaxPollWindowMs(env({}));
    expect(resolvePollWindowMs(String(max * 10), env({}))).toBe(max);
    expect(resolvePollWindowMs("5000", env({ WALKIE_TALKIE_MAX_POLL_WINDOW_MS: "3000" }))).toBe(3000);
  });

  it("clamps below a floor so a client cannot spin the hub", () => {
    expect(resolvePollWindowMs("1")).toBeGreaterThanOrEqual(1000);
  });

  it("keeps the default strictly below the client's default abort, or reaping returns", () => {
    // The hub must answer before the client aborts; a client-side abort is what fires the
    // disconnect path and arms the stale-registration grace.
    expect(resolvePollWindowMs(null, env({}))).toBeLessThan(30_000);
  });
});
