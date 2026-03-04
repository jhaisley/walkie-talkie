import { beforeEach, describe, expect, it } from "vitest";
import {
  ensureChannelMembership,
  getChannelMembers,
  getUserChannels,
  initGeneralChannel,
  isChannelMember,
  joinChannel,
  leaveChannel,
  removeChannel,
  removeUserFromAllChannels,
  resetChannelState,
} from "../channels.js";
import { dbCreateChannel, initDB } from "../db.js";

beforeEach(() => {
  process.env.WALKIE_TALKIE_DB_PATH = ":memory:";
  initDB();
  resetChannelState();
  initGeneralChannel();
});

describe("joinChannel", () => {
  it("should add a user to an existing channel", () => {
    joinChannel("#all", "alice");
    expect(getChannelMembers("#all")).toContain("alice");
  });

  it("should throw when joining a non-existent channel", () => {
    expect(() => joinChannel("#nope", "alice")).toThrow("does not exist");
  });
});

describe("leaveChannel", () => {
  it("should remove a user from a channel", () => {
    joinChannel("#all", "alice");
    leaveChannel("#all", "alice");
    expect(getChannelMembers("#all")).not.toContain("alice");
  });
});

describe("isChannelMember", () => {
  it("should return true for members", () => {
    joinChannel("#all", "alice");
    expect(isChannelMember("#all", "alice")).toBe(true);
  });

  it("should return false for non-members", () => {
    expect(isChannelMember("#all", "nobody")).toBe(false);
  });
});

describe("removeUserFromAllChannels", () => {
  it("should remove user from every channel", () => {
    dbCreateChannel("#room", "alice");
    joinChannel("#all", "alice");
    joinChannel("#room", "alice");
    removeUserFromAllChannels("alice");
    expect(isChannelMember("#all", "alice")).toBe(false);
    expect(isChannelMember("#room", "alice")).toBe(false);
  });
});

describe("getUserChannels", () => {
  it("should return all channels a user belongs to", () => {
    dbCreateChannel("#room", "alice");
    joinChannel("#all", "alice");
    joinChannel("#room", "alice");
    const channels = getUserChannels("alice");
    expect(channels).toContain("#all");
    expect(channels).toContain("#room");
  });
});

describe("removeChannel", () => {
  it("should remove the channel from in-memory state", () => {
    dbCreateChannel("#temp", "alice");
    ensureChannelMembership("#temp");
    joinChannel("#temp", "alice");
    removeChannel("#temp");
    expect(getChannelMembers("#temp")).toEqual([]);
  });
});
