import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

describe("POST /channel-create", () => {
  it("should create a channel and auto-join creator", async () => {
    const token = await registerUser(ctx, "ch-creator");
    const res = await fetch(`${ctx.baseUrl}/channel-create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "test-room" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; channel: string };
    expect(body.channel).toBe("#test-room");
  });

  it("should reject duplicate channel creation", async () => {
    const token = await registerUser(ctx, "ch-dup-creator");
    await fetch(`${ctx.baseUrl}/channel-create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "dup-room" }),
    });
    const res = await fetch(`${ctx.baseUrl}/channel-create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "dup-room" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("POST /channel-join", () => {
  it("should join an existing channel", async () => {
    const creatorToken = await registerUser(ctx, "join-creator");
    await fetch(`${ctx.baseUrl}/channel-create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creatorToken}`,
      },
      body: JSON.stringify({ name: "join-room" }),
    });

    const joinerToken = await registerUser(ctx, "join-joiner");
    const res = await fetch(`${ctx.baseUrl}/channel-join`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${joinerToken}`,
      },
      body: JSON.stringify({ channel: "#join-room" }),
    });
    expect(res.status).toBe(200);
  });

  it("should reject joining non-existent channel", async () => {
    const token = await registerUser(ctx, "join-fail");
    const res = await fetch(`${ctx.baseUrl}/channel-join`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel: "#nonexistent" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /channel-leave", () => {
  it("should leave a channel", async () => {
    const token = await registerUser(ctx, "leave-user");
    await fetch(`${ctx.baseUrl}/channel-create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "leave-room" }),
    });
    const res = await fetch(`${ctx.baseUrl}/channel-leave`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel: "#leave-room" }),
    });
    expect(res.status).toBe(200);
  });

  it("should reject leaving #all", async () => {
    const token = await registerUser(ctx, "leave-all");
    const res = await fetch(`${ctx.baseUrl}/channel-leave`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel: "#all" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /channel-invite", () => {
  it("should invite a user to a channel", async () => {
    const creatorToken = await registerUser(ctx, "inv-creator");
    await registerUser(ctx, "inv-target");
    await fetch(`${ctx.baseUrl}/channel-create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creatorToken}`,
      },
      body: JSON.stringify({ name: "inv-room" }),
    });
    const res = await fetch(`${ctx.baseUrl}/channel-invite`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creatorToken}`,
      },
      body: JSON.stringify({ channel: "#inv-room", user: "inv-target" }),
    });
    expect(res.status).toBe(200);
  });

  it("should reject inviting non-existent user", async () => {
    const token = await registerUser(ctx, "inv-nope-creator");
    await fetch(`${ctx.baseUrl}/channel-create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "inv-nope-room" }),
    });
    const res = await fetch(`${ctx.baseUrl}/channel-invite`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel: "#inv-nope-room", user: "ghost" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /channel-history", () => {
  it("should return channel history for members", async () => {
    const token = await registerUser(ctx, "hist-user");
    const res = await fetch(`${ctx.baseUrl}/channel-history?channel=${encodeURIComponent("#all")}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: unknown[] };
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it("should reject when not a member of channel", async () => {
    const creatorToken = await registerUser(ctx, "hist-creator2");
    await fetch(`${ctx.baseUrl}/channel-create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creatorToken}`,
      },
      body: JSON.stringify({ name: "hist-private" }),
    });

    const otherToken = await registerUser(ctx, "hist-outsider");
    const res = await fetch(`${ctx.baseUrl}/channel-history?channel=${encodeURIComponent("#hist-private")}`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /channels", () => {
  it("should list channels with member info", async () => {
    const res = await fetch(`${ctx.baseUrl}/channels`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channels: { name: string; memberCount: number; members: string[] }[];
    };
    expect(Array.isArray(body.channels)).toBe(true);
    const all = body.channels.find((c) => c.name === "#all");
    expect(all).toBeDefined();
  });
});
