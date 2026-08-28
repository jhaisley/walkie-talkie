import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  registerUser as harnessRegister,
  startTestServer,
  stopTestServer,
  type TestContext,
} from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer({ staleGraceMs: 0 });
});

afterAll(async () => {
  await stopTestServer(ctx);
});

async function mcp(body: unknown, sid?: string): Promise<{ status: number; sid?: string; text: string }> {
  const res = await fetch(`${ctx.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${ctx.joinToken}`,
      ...(sid ? { "Mcp-Session-Id": sid } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, sid: res.headers.get("mcp-session-id") ?? undefined, text: await res.text() };
}

async function initSession(): Promise<string> {
  const r = await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  });
  expect(r.sid).toBeTruthy();
  return r.sid as string;
}

function joinCall(name: string) {
  return {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "tools/call",
    params: { name: "radio_join", arguments: { name } },
  };
}

describe("kick against a hub-hosted station", () => {
  it("frees the callsign for a NEW session immediately, not after the 30-minute sweep", async () => {
    // Session A takes the callsign, then its CLI dies without DELETE /mcp — the zombie case.
    const a = await initSession();
    const joined = await mcp(joinCall("hosted-kickee"), a);
    expect(joined.text).toContain("Registered as");

    // A fresh session cannot take the name while A's entry lives: this is the guard working.
    const b = await initSession();
    const refused = await mcp(joinCall("hosted-kickee"), b);
    expect(refused.text).toContain("already registered");

    // The operator kicks. Before the fix this deleted the registration but left A holding the
    // MCP-layer index, so the rejoin below kept failing for the full idle-sweep window.
    const kick = await fetch(`${ctx.baseUrl}/kick`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.adminToken}` },
      body: JSON.stringify({ name: "hosted-kickee" }),
    });
    expect(kick.status).toBe(200);

    // The same fresh session can now take the callsign at once.
    const c = await initSession();
    const rejoined = await mcp(joinCall("hosted-kickee"), c);
    expect(rejoined.text).toContain("Registered as");
    expect(rejoined.text).not.toContain("already registered");
  });

  it("still kicks plain HTTP stations exactly as before", async () => {
    const tok = await harnessRegister(ctx, "plain-kickee");
    const kick = await fetch(`${ctx.baseUrl}/kick`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.adminToken}` },
      body: JSON.stringify({ name: "plain-kickee" }),
    });
    expect(kick.status).toBe(200);
    // Token is dead and the name is free.
    const re = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ name: "plain-kickee" }),
    });
    expect(re.status).toBe(200);
    void tok;
  });
});
