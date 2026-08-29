import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  process.env.WALKIE_TALKIE_WALL_ALLOWED = "seeded-op";
  ctx = await startTestServer({ staleGraceMs: 0 });
});
afterAll(async () => {
  delete process.env.WALKIE_TALKIE_WALL_ALLOWED;
  await stopTestServer(ctx);
});

const adminHdr = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${ctx.adminToken}` });
async function admin(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${ctx.baseUrl}${path}`, { method: "POST", headers: adminHdr(), body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function whois(name: string) {
  const res = await fetch(`${ctx.baseUrl}/whois?name=${name}`, { headers: adminHdr() });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function sendAll(token: string) {
  const res = await fetch(`${ctx.baseUrl}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: "@all", channel: "#all", content: "announce" }),
  });
  return res.status;
}

describe("operator privilege", () => {
  it("the env var seeds ops once; a seeded station may send into #all", async () => {
    const tok = await registerUser(ctx, "seeded-op");
    expect(await sendAll(tok)).toBe(200);
  });

  it("/op grants at runtime and the grant is visible in /whois and effective immediately", async () => {
    const tok = await registerUser(ctx, "newbie");
    expect(await sendAll(tok)).toBe(404); // not yet an op
    const r = await admin("/op", { name: "newbie" });
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(true);
    expect((await whois("newbie")).body.op).toBe(true);
    expect(await sendAll(tok)).toBe(200);
  });

  it("/deop revokes, and the revocation is effective immediately", async () => {
    const tok = await registerUser(ctx, "temp-op");
    await admin("/op", { name: "temp-op" });
    expect(await sendAll(tok)).toBe(200);
    const r = await admin("/deop", { name: "temp-op" });
    expect(r.body.changed).toBe(true);
    expect(await sendAll(tok)).toBe(404);
  });

  it("cannot op the reserved identities", async () => {
    expect((await admin("/op", { name: "operator" })).status).toBe(400);
    expect((await admin("/op", { name: "wall" })).status).toBe(400);
  });

  it("/op is admin-token-only: an op'd station cannot op another", async () => {
    const tok = await registerUser(ctx, "op-a");
    await admin("/op", { name: "op-a" });
    const res = await fetch(`${ctx.baseUrl}/op`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name: "op-b" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("/whois", () => {
  it("reports liveness, op status, unclaimed, and channels in one read", async () => {
    await registerUser(ctx, "who-target");
    const r = await whois("who-target");
    expect(r.status).toBe(200);
    expect(r.body.name).toBe("who-target");
    expect(typeof r.body.online).toBe("boolean");
    expect(typeof r.body.hasActivePoll).toBe("boolean");
    expect(typeof r.body.unclaimed).toBe("boolean");
    expect(r.body.op).toBe(false);
    expect(Array.isArray(r.body.channels)).toBe(true);
  });
  it("404s for an unregistered name", async () => {
    expect((await whois("nobody-here")).status).toBe(404);
  });
});

describe("/kill and /kick alias, /admin-channel-kick", () => {
  it("/kill terminates, and /kick is an alias for it", async () => {
    await registerUser(ctx, "doomed-1");
    await registerUser(ctx, "doomed-2");
    expect((await admin("/kill", { name: "doomed-1" })).body.killed).toBe("doomed-1");
    expect((await admin("/kick", { name: "doomed-2" })).body.kicked).toBe("doomed-2"); // alias keeps its old key
    expect((await whois("doomed-1")).status).toBe(404);
  });

  it("channel kick removes from one channel only, refuses #all, and 404s a non-member", async () => {
    const a = await registerUser(ctx, "ck-a");
    await fetch(`${ctx.baseUrl}/channel-create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${a}` },
      body: JSON.stringify({ name: "#room" }),
    });
    expect((await admin("/admin-channel-kick", { channel: "#room", name: "ck-a" })).status).toBe(200);
    expect((await whois("ck-a")).status).toBe(200); // still registered
    expect(((await whois("ck-a")).body.channels as string[]).includes("#room")).toBe(false);
    expect((await admin("/admin-channel-kick", { channel: "#all", name: "ck-a" })).status).toBe(400);
    expect((await admin("/admin-channel-kick", { channel: "#room", name: "ck-a" })).status).toBe(404);
  });
});
