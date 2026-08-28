import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  enrollStation,
  registerWith,
  startTestServer,
  stopTestServer,
  type TestContext,
} from "./helpers/server-harness.js";

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

/**
 * The Phase-4 flag. Everything before it is a superset of the old behaviour; this is the one
 * switch that can turn a working station away, which is why it defaults off and is read at call
 * time — the flip is an env change, and so is the revert.
 */
describe("WALKIE_TALKIE_REQUIRE_STATION_KEY", () => {
  afterEach(() => {
    delete process.env.WALKIE_TALKIE_REQUIRE_STATION_KEY;
  });

  it("is off by default, so the join token still registers", async () => {
    expect(process.env.WALKIE_TALKIE_REQUIRE_STATION_KEY).toBeUndefined();
    const res = await registerWith(ctx, ctx.joinToken, { name: "default-on-join-token" });
    expect(res.status).toBe(200);
  });

  it("turns a valid join-token register into a 403 that names the remedy", async () => {
    process.env.WALKIE_TALKIE_REQUIRE_STATION_KEY = "1";
    const res = await registerWith(ctx, ctx.joinToken, { name: "gated" });
    expect(res.status).toBe(403);
    // An operator reading a hub log or an agent pane has to be able to act on this without
    // knowing the flag exists.
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("enrollment code");
  });

  it("still admits a station key while the flag is set", async () => {
    const key = await enrollStation(ctx, "keyed");
    process.env.WALKIE_TALKIE_REQUIRE_STATION_KEY = "1";
    const res = await registerWith(ctx, key, { name: "keyed" });
    expect(res.status).toBe(200);
  });

  it("treats an empty or unrecognised value as off", async () => {
    for (const value of ["", "0", "no", "maybe"]) {
      process.env.WALKIE_TALKIE_REQUIRE_STATION_KEY = value;
      const res = await registerWith(ctx, ctx.joinToken, { name: `flag-${value || "empty"}` });
      expect(res.status, `value ${JSON.stringify(value)} should not gate`).toBe(200);
    }
  });
});
