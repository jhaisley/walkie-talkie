import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  process.env.WALKIE_TALKIE_WALL_ALLOWED = "announcer,announcer2";
  ctx = await startTestServer({ staleGraceMs: 0 });
});

afterAll(async () => {
  delete process.env.WALKIE_TALKIE_WALL_ALLOWED;
  await stopTestServer(ctx);
});

async function wall(token: string, body: Record<string, unknown>) {
  const res = await fetch(`${ctx.baseUrl}/wall`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function inbox(token: string): Promise<Array<{ from: string; content: string }>> {
  const res = await fetch(`${ctx.baseUrl}/inbox`, { headers: { Authorization: `Bearer ${token}` } });
  return ((await res.json()) as { messages: Array<{ from: string; content: string }> }).messages;
}

describe("POST /wall", () => {
  it("admin token: delivers from 'wall' with the issuer in the text, NOT from operator", async () => {
    const listener = await registerUser(ctx, "listener1");
    const r = await wall(ctx.adminToken, { content: "hub restarting in 30s", issuer: "deploy" });
    expect(r.status).toBe(200);
    const got = (await inbox(listener)).find((m) => m.content.includes("hub restarting"));
    expect(got?.from).toBe("wall");
    expect(got?.content).toBe("[WALL from deploy] hub restarting in 30s");
  });

  it("an allow-listed station may wall, and the issuer is its AUTHENTICATED callsign", async () => {
    const announcer = await registerUser(ctx, "announcer");
    const listener = await registerUser(ctx, "listener2");
    // The station cannot choose its issuer label: body.issuer is admin-path only, so an attempt
    // to pass issuer "operator" here must be ignored in favour of the authenticated callsign.
    const r = await wall(announcer, { content: "fleet restart pass beginning", issuer: "operator" });
    expect(r.status).toBe(200);
    const got = (await inbox(listener)).find((m) => m.content.includes("fleet restart"));
    expect(got?.from).toBe("wall");
    expect(got?.content).toBe("[WALL from announcer] fleet restart pass beginning");
  });

  it("a station NOT on the allow-list gets 403", async () => {
    const rando = await registerUser(ctx, "rando");
    const r = await wall(rando, { content: "hello everyone" });
    expect(r.status).toBe(403);
  });

  it("no credential gets 401", async () => {
    const r = await wall("not-a-token", { content: "x" });
    expect(r.status).toBe(401);
  });

  it("blocks an unauthorized station's broadcast into #all, with a pointer to the fix", async () => {
    const chatty = await registerUser(ctx, "chatty");
    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${chatty}` },
      body: JSON.stringify({ to: "@all", channel: "#all", content: "hello everyone" }),
    });
    expect(res.status).toBe(404);
    const err = ((await res.json()) as { error: string }).error;
    expect(err).toContain("announcement-only");
    expect(err).toContain("WALKIE_TALKIE_WALL_ALLOWED");
  });

  it("blocks a DM inside #all too — it lands in the shared history, so it is not private", async () => {
    const a = await registerUser(ctx, "dm-a");
    await registerUser(ctx, "dm-b");
    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${a}` },
      body: JSON.stringify({ to: "@dm-b", channel: "#all", content: "just for you" }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("announcement-only");
  });

  it("an allow-listed station may still send into #all", async () => {
    const announcer2 = await registerUser(ctx, "announcer2");
    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${announcer2}` },
      body: JSON.stringify({ to: "@all", channel: "#all", content: "authorized broadcast" }),
    });
    expect(res.status).toBe(200);
  });

  it("does NOT gate a purpose channel: DMs and @all both work there", async () => {
    const a = await registerUser(ctx, "scoped-a");
    const b = await registerUser(ctx, "scoped-b");
    await fetch(`${ctx.baseUrl}/channel-create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${a}` },
      body: JSON.stringify({ name: "#scoped" }),
    });
    await fetch(`${ctx.baseUrl}/channel-join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${b}` },
      body: JSON.stringify({ channel: "#scoped" }),
    });
    const dm = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${a}` },
      body: JSON.stringify({ to: "@scoped-b", channel: "#scoped", content: "just for you" }),
    });
    expect(dm.status).toBe(200);
    const roomcast = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${a}` },
      body: JSON.stringify({ to: "@all", channel: "#scoped", content: "room only" }),
    });
    expect(roomcast.status).toBe(200);
  });

  it("the identity itself is reserved: nobody can register as 'wall'", async () => {
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ name: "wall" }),
    });
    expect(res.status).toBe(403);
  });
});
