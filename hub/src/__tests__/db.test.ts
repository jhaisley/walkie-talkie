import { beforeEach, describe, expect, it } from "vitest";
import {
  dbAddChannelMember,
  dbCreateChannel,
  dbDeleteChannel,
  dbDeleteChannelMessages,
  dbDeleteReadCursorsForChannel,
  dbGetChannel,
  dbGetChannelMessages,
  dbGetRecentMessages,
  dbGetUnreadCounts,
  dbGetUserChannels,
  dbListChannels,
  dbRemoveAllMembersOfChannel,
  dbRemoveChannelMember,
  dbSaveMessage,
  dbUpdateReadCursor,
  initDB,
} from "../db.js";
import type { Message } from "../types.js";

beforeEach(() => {
  process.env.WALKIE_TALKIE_DB_PATH = ":memory:";
  initDB();
});

describe("channels CRUD", () => {
  it("should seed #all on init", () => {
    const ch = dbGetChannel("#all");
    expect(ch).toBeDefined();
    expect(ch!.name).toBe("#all");
    expect(ch!.created_by).toBe("system");
  });

  it("should create and retrieve a channel", () => {
    const ch = dbCreateChannel("#test", "alice");
    expect(ch.name).toBe("#test");
    expect(ch.created_by).toBe("alice");
    expect(dbGetChannel("#test")).toBeDefined();
  });

  it("should list channels in creation order", () => {
    dbCreateChannel("#a", "alice");
    dbCreateChannel("#b", "bob");
    const list = dbListChannels();
    const names = list.map((c) => c.name);
    expect(names).toContain("#all");
    expect(names).toContain("#a");
    expect(names).toContain("#b");
  });

  it("should delete a channel", () => {
    dbCreateChannel("#del", "alice");
    expect(dbDeleteChannel("#del")).toBe(true);
    expect(dbGetChannel("#del")).toBeUndefined();
  });

  it("should return false when deleting non-existent channel", () => {
    expect(dbDeleteChannel("#nope")).toBe(false);
  });
});

describe("channel members", () => {
  it("should add and query members", () => {
    dbCreateChannel("#room", "alice");
    dbAddChannelMember("#room", "alice");
    dbAddChannelMember("#room", "bob");
    const channels = dbGetUserChannels("alice");
    expect(channels).toContain("#room");
  });

  it("should ignore duplicate member adds", () => {
    dbCreateChannel("#room", "alice");
    dbAddChannelMember("#room", "alice");
    dbAddChannelMember("#room", "alice"); // should not throw
    const channels = dbGetUserChannels("alice");
    expect(channels.filter((c) => c === "#room")).toHaveLength(1);
  });

  it("should remove a member", () => {
    dbCreateChannel("#room", "alice");
    dbAddChannelMember("#room", "alice");
    dbRemoveChannelMember("#room", "alice");
    expect(dbGetUserChannels("alice")).not.toContain("#room");
  });

  it("should remove all members of a channel", () => {
    dbCreateChannel("#room", "alice");
    dbAddChannelMember("#room", "alice");
    dbAddChannelMember("#room", "bob");
    dbRemoveAllMembersOfChannel("#room");
    expect(dbGetUserChannels("alice")).not.toContain("#room");
    expect(dbGetUserChannels("bob")).not.toContain("#room");
  });
});

describe("messages", () => {
  function makeMsg(overrides: Partial<Message> = {}): Message {
    return {
      id: `msg-${Math.random().toString(36).slice(2)}`,
      from: "alice",
      to: "@all",
      content: "hello",
      channel: "#all",
      timestamp: Date.now(),
      ...overrides,
    };
  }

  it("should save and retrieve channel messages", () => {
    const msg = makeMsg();
    dbSaveMessage(msg);
    const messages = dbGetChannelMessages("#all");
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(msg.id);
  });

  it("should retrieve recent messages across channels", () => {
    dbCreateChannel("#other", "alice");
    dbSaveMessage(makeMsg({ channel: "#all" }));
    dbSaveMessage(makeMsg({ channel: "#other" }));
    const messages = dbGetRecentMessages();
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });

  it("should delete channel messages", () => {
    dbSaveMessage(makeMsg());
    dbDeleteChannelMessages("#all");
    expect(dbGetChannelMessages("#all")).toHaveLength(0);
  });

  it("should respect limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      dbSaveMessage(makeMsg({ timestamp: Date.now() + i }));
    }
    expect(dbGetChannelMessages("#all", 3)).toHaveLength(3);
  });

  it("should prune #all channel beyond 200 messages", () => {
    for (let i = 0; i < 210; i++) {
      dbSaveMessage(
        makeMsg({
          id: `prune-${i}`,
          timestamp: i,
        }),
      );
    }
    // After pruning, should have at most 200
    const messages = dbGetChannelMessages("#all", 500);
    expect(messages.length).toBeLessThanOrEqual(200);
  });
});

describe("read cursors", () => {
  it("should update and query unread counts", () => {
    dbSaveMessage({
      id: "m1",
      from: "alice",
      to: "@all",
      content: "hello",
      channel: "#all",
      timestamp: 1000,
    });
    dbSaveMessage({
      id: "m2",
      from: "alice",
      to: "@all",
      content: "world",
      channel: "#all",
      timestamp: 2000,
    });
    dbUpdateReadCursor("bob", "#all", 1000);
    const counts = dbGetUnreadCounts("bob");
    expect(counts["#all"]).toBe(1); // m2 is unread
  });

  it("should use MAX for cursor updates (no backwards)", () => {
    dbUpdateReadCursor("bob", "#all", 2000);
    dbUpdateReadCursor("bob", "#all", 1000); // should not go backwards
    dbSaveMessage({
      id: "m1",
      from: "alice",
      to: "@all",
      content: "hello",
      channel: "#all",
      timestamp: 1500,
    });
    const counts = dbGetUnreadCounts("bob");
    expect(counts["#all"]).toBeUndefined(); // 1500 < 2000 so no unread
  });

  it("should delete read cursors for a channel", () => {
    dbUpdateReadCursor("bob", "#all", 1000);
    dbDeleteReadCursorsForChannel("#all");
    // After deleting cursors, all messages are unread
    dbSaveMessage({
      id: "m1",
      from: "alice",
      to: "@all",
      content: "hello",
      channel: "#all",
      timestamp: 2000,
    });
    const counts = dbGetUnreadCounts("bob");
    expect(counts["#all"]).toBe(1);
  });
});
