import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

describe("authentication", () => {
  it("should reject /register without join token", async () => {
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "alice" }),
    });
    expect(res.status).toBe(401);
  });

  it("should reject /send without user token", async () => {
    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "@all", content: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("should reject /kick without admin token", async () => {
    const res = await fetch(`${ctx.baseUrl}/kick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "alice" }),
    });
    expect(res.status).toBe(401);
  });

  it("should reject wrong method on /register", async () => {
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "GET",
      headers: { Authorization: `Bearer ${ctx.joinToken}` },
    });
    expect(res.status).toBe(405);
  });

  it("should reject wrong method on /send", async () => {
    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "GET",
    });
    expect(res.status).toBe(405);
  });

  it("should reject wrong method on /kick", async () => {
    const res = await fetch(`${ctx.baseUrl}/kick`, {
      method: "GET",
    });
    expect(res.status).toBe(405);
  });

  it("should return 404 for unknown paths", async () => {
    const res = await fetch(`${ctx.baseUrl}/unknown`);
    expect(res.status).toBe(404);
  });

  it("should allow public access to /users", async () => {
    const res = await fetch(`${ctx.baseUrl}/users`);
    expect(res.status).toBe(200);
  });

  it("should allow public access to /channels", async () => {
    const res = await fetch(`${ctx.baseUrl}/channels`);
    expect(res.status).toBe(200);
  });
});
