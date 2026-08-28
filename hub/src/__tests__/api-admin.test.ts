import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

function adminHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ctx.adminToken}`,
  };
}

describe("POST /kick", () => {
  it("should kick a registered user", async () => {
    await registerUser(ctx, "kick-target");
    const res = await fetch(`${ctx.baseUrl}/kick`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "kick-target" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; kicked: string };
    expect(body.kicked).toBe("kick-target");
  });

  it("should return 404 for non-existent user", async () => {
    const res = await fetch(`${ctx.baseUrl}/kick`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "nobody" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /kick-all", () => {
  it("should kick all agents but exclude operator", async () => {
    await registerUser(ctx, "ka-agent1");
    await registerUser(ctx, "ka-agent2");
    // Bring "operator" into existence the way production does: /register now refuses the
    // reserved name, and handleAdminSend auto-registers the sender on the first admin message.
    await fetch(`${ctx.baseUrl}/admin-send`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ to: "@all", content: "seed operator" }),
    });

    const res = await fetch(`${ctx.baseUrl}/kick-all`, {
      method: "POST",
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; kicked: string[] };
    expect(body.kicked).not.toContain("operator");
    expect(body.kicked).toContain("ka-agent1");
    expect(body.kicked).toContain("ka-agent2");

    // Verify operator is still registered
    const usersRes = await fetch(`${ctx.baseUrl}/users`);
    const usersBody = (await usersRes.json()) as { users: { name: string }[] };
    expect(usersBody.users.map((u) => u.name)).toContain("operator");
  });
});

describe("POST /admin-send", () => {
  it("should send a message as operator", async () => {
    await registerUser(ctx, "admin-recv");
    const res = await fetch(`${ctx.baseUrl}/admin-send`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ to: "@all", content: "admin message" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; to: string };
    expect(body.to).toBe("@all");
  });

  it("should send a message with image as operator", async () => {
    await registerUser(ctx, "admin-img-recv");
    const res = await fetch(`${ctx.baseUrl}/admin-send`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        to: "@all",
        content: "see this",
        image: { data: "iVBORw0KGgo=", mimeType: "image/png" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; to: string };
    expect(body.id).toBeTruthy();
  });

  it("should accept image-only admin message", async () => {
    await registerUser(ctx, "admin-imgonly-recv");
    const res = await fetch(`${ctx.baseUrl}/admin-send`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        to: "@all",
        image: { data: "iVBORw0KGgo=", mimeType: "image/png" },
      }),
    });
    expect(res.status).toBe(200);
  });

  it("should reject missing fields", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-send`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ to: "@all" }), // missing content
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /admin-channel-create", () => {
  it("should create a channel as admin", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-channel-create`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "admin-room" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; channel: string };
    expect(body.channel).toBe("#admin-room");
  });

  it("should reject duplicate channel", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-channel-create`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "admin-room" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("POST /admin-channel-delete", () => {
  it("should delete a channel", async () => {
    await fetch(`${ctx.baseUrl}/admin-channel-create`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "admin-del-room" }),
    });
    const res = await fetch(`${ctx.baseUrl}/admin-channel-delete`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "#admin-del-room" }),
    });
    expect(res.status).toBe(200);
  });

  it("should reject deleting #all", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-channel-delete`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "#all" }),
    });
    expect(res.status).toBe(400);
  });

  it("should return 404 for non-existent channel", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-channel-delete`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "#nope" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /admin-channel-history", () => {
  it("should return message history for a channel", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-channel-history?channel=${encodeURIComponent("#all")}`, {
      headers: { Authorization: `Bearer ${ctx.adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: unknown[] };
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it("should return recent messages without channel param", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-channel-history`, {
      headers: { Authorization: `Bearer ${ctx.adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: unknown[] };
    expect(Array.isArray(body.messages)).toBe(true);
  });
});

describe("POST /admin-mark-read", () => {
  it("should mark a channel as read", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-mark-read`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ channel: "#all" }),
    });
    expect(res.status).toBe(200);
  });

  it("should reject missing channel", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-mark-read`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /admin-unread-counts", () => {
  it("should return unread counts for operator", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-unread-counts`, {
      headers: { Authorization: `Bearer ${ctx.adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: Record<string, number> };
    expect(typeof body.counts).toBe("object");
  });
});
