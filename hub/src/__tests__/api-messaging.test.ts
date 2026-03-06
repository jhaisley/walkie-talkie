import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

describe("POST /send", () => {
  it("should send a broadcast message", async () => {
    const aliceToken = await registerUser(ctx, "msg-alice");
    await registerUser(ctx, "msg-bob");

    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({ to: "@all", content: "hello everyone" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; to: string };
    expect(body.to).toBe("@all");
    expect(body.id).toBeTruthy();
  });

  it("should send a DM", async () => {
    const aliceToken = await registerUser(ctx, "dm-alice");
    await registerUser(ctx, "dm-bob");

    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({ to: "@dm-bob", content: "hi bob" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; to: string };
    expect(body.to).toBe("dm-bob");
  });

  it("should handle TYPING indicator", async () => {
    const token = await registerUser(ctx, "typing-user");
    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to: "@all", content: "TYPING", channel: "#general" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("typing");
  });

  it("should reject missing fields", async () => {
    const token = await registerUser(ctx, "send-bad");
    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to: "@all" }), // missing content
    });
    expect(res.status).toBe(400);
  });

  it("should return 404 when target user not found", async () => {
    const token = await registerUser(ctx, "send-nouser");
    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to: "@ghost", content: "hello" }),
    });
    expect(res.status).toBe(404);
  });

  it("should send a message with image", async () => {
    const token = await registerUser(ctx, "img-sender");
    await registerUser(ctx, "img-receiver");

    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: "@all",
        content: "check this image",
        image: { data: "iVBORw0KGgo=", mimeType: "image/png" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; to: string };
    expect(body.id).toBeTruthy();
  });

  it("should accept image-only message without content", async () => {
    const token = await registerUser(ctx, "imgonly-sender");
    await registerUser(ctx, "imgonly-receiver");

    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: "@all",
        image: { data: "iVBORw0KGgo=", mimeType: "image/png" },
      }),
    });
    expect(res.status).toBe(200);
  });

  it("should reject unauthorized send", async () => {
    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "@all", content: "hi" }),
    });
    expect(res.status).toBe(401);
  });
});
