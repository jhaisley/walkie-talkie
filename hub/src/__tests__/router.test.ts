import { beforeEach, describe, expect, it } from "vitest";
import { registerUser, resetAuthState } from "../auth.js";
import { initGeneralChannel, joinChannel, resetChannelState } from "../channels.js";
import { dbCreateChannel, initDB } from "../db.js";
import { drainQueue, ensureQueue, removeQueue, routeMessage } from "../router.js";

beforeEach(() => {
  process.env.WALKIE_TALKIE_DB_PATH = ":memory:";
  initDB();
  resetAuthState();
  resetChannelState();
  initGeneralChannel();
});

describe("queue management", () => {
  it("should create and drain a queue", () => {
    ensureQueue("alice");
    const msgs = drainQueue("alice");
    expect(msgs).toEqual([]);
  });

  it("should return empty array for non-existent queue", () => {
    expect(drainQueue("nobody")).toEqual([]);
  });

  it("should remove a queue", () => {
    ensureQueue("alice");
    removeQueue("alice");
    expect(drainQueue("alice")).toEqual([]);
  });
});

describe("routeMessage", () => {
  it("should broadcast @all to all channel members except sender", () => {
    const alice = registerUser("alice");
    const bob = registerUser("bob");
    ensureQueue(alice.name);
    ensureQueue(bob.name);
    joinChannel("#all", "alice");
    joinChannel("#all", "bob");

    const msg = routeMessage("alice", "@all", "hello");
    expect(msg.from).toBe("alice");
    expect(msg.to).toBe("@all");
    expect(msg.channel).toBe("#all");

    // Bob should have the message queued
    const bobMsgs = drainQueue("bob");
    expect(bobMsgs).toHaveLength(1);
    expect(bobMsgs[0].content).toBe("hello");

    // Alice (sender) should NOT have it
    const aliceMsgs = drainQueue("alice");
    expect(aliceMsgs).toHaveLength(0);
  });

  it("should deliver DM to target user", () => {
    registerUser("alice");
    registerUser("bob");
    ensureQueue("alice");
    ensureQueue("bob");
    joinChannel("#all", "alice");
    joinChannel("#all", "bob");

    const msg = routeMessage("alice", "@bob", "hi bob");
    expect(msg.to).toBe("bob");

    const bobMsgs = drainQueue("bob");
    expect(bobMsgs).toHaveLength(1);
  });

  it("should throw when target user is not registered", () => {
    registerUser("alice");
    ensureQueue("alice");
    joinChannel("#all", "alice");

    expect(() => routeMessage("alice", "@nobody", "hi")).toThrow("not connected");
  });

  it("should throw when target is not in the channel", () => {
    registerUser("alice");
    registerUser("bob");
    ensureQueue("alice");
    joinChannel("#all", "alice");
    // bob not joined to #all

    expect(() => routeMessage("alice", "@bob", "hi")).toThrow("not a member");
  });

  it("should route messages in custom channels", () => {
    registerUser("alice");
    registerUser("bob");
    ensureQueue("alice");
    ensureQueue("bob");
    dbCreateChannel("#room", "alice");
    joinChannel("#room", "alice");
    joinChannel("#room", "bob");

    const msg = routeMessage("alice", "@all", "room msg", "#room");
    expect(msg.channel).toBe("#room");

    const bobMsgs = drainQueue("bob");
    expect(bobMsgs).toHaveLength(1);
    expect(bobMsgs[0].channel).toBe("#room");
  });

  it("should include image in routed message", () => {
    registerUser("alice");
    registerUser("bob");
    ensureQueue("alice");
    ensureQueue("bob");
    joinChannel("#all", "alice");
    joinChannel("#all", "bob");

    const image = { data: "iVBORw0KGgo=", mimeType: "image/png" };
    const msg = routeMessage("alice", "@all", "check this", "#all", image);
    expect(msg.image).toEqual(image);

    const bobMsgs = drainQueue("bob");
    expect(bobMsgs).toHaveLength(1);
    expect(bobMsgs[0].image).toEqual(image);
  });
});
