import { beforeEach, describe, expect, it } from "vitest";

process.env.WALKIE_TALKIE_DB_PATH = ":memory:";

const { initDB } = await import("../db.js");
const { channelExists, initGeneralChannel, joinChannel, normalizeChannel, resetChannelState } = await import(
  "../channels.js"
);
const { registerUser, unregisterUser } = await import("../auth.js");
const { routeMessage, ensureQueue } = await import("../router.js");

describe("channel normalization and validation", () => {
  beforeEach(() => {
    initDB();
    resetChannelState();
    initGeneralChannel();
  });

  it("canonicalises a missing # and surrounding space", () => {
    expect(normalizeChannel("infra")).toBe("#infra");
    expect(normalizeChannel("  infra  ")).toBe("#infra");
    expect(normalizeChannel("#infra")).toBe("#infra");
    expect(normalizeChannel("")).toBe("");
  });

  it("treats a de-hashed name as the same channel, not an empty new one", () => {
    expect(channelExists("all")).toBe(true);
    expect(channelExists("#all")).toBe(true);
  });

  it("rejects a broadcast to a channel that does not exist, instead of 200-ing into the void", () => {
    registerUser("sender");
    ensureQueue("sender");
    joinChannel("#all", "sender");
    // The exact failure this closes: nine messages reached zero recipients while reporting success.
    expect(() => routeMessage("sender", "@all", "hello", "#nope")).toThrow(/does not exist/);
    unregisterUser("sender");
  });

  it("accepts the same broadcast once the channel exists", () => {
    registerUser("sender");
    ensureQueue("sender");
    joinChannel("#all", "sender");
    const m = routeMessage("sender", "@all", "hello", "all");
    expect(m.channel).toBe("#all"); // recorded canonically, not as the caller spelled it
    unregisterUser("sender");
  });
});
