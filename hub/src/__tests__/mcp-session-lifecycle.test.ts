import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeAllMcpSessions,
  DeliveryCursor,
  mcpSessionCount,
  resolveMcpSessionIdleMs,
  sweepMcpSessions,
} from "../mcp.js";
import { startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

/**
 * Session teardown: the paths that decide whether a station keeps its callsign.
 *
 * Getting this wrong is the expensive failure in this system. A cancelled tool call read as a
 * dead station once auto-unregistered the entire fleet mid-work, and the idle sweeper is the
 * same trap in a new place — so the distinctions are asserted rather than assumed.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await closeAllMcpSessions(0);
  ctx.server.closeAllConnections();
  await stopTestServer(ctx);
});

async function connectAndJoin(name: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${ctx.baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${ctx.joinToken}` } },
  });
  const client = new Client({ name: "test-station", version: "1.0.0" });
  await client.connect(transport);
  await client.callTool({ name: "radio_join", arguments: { name } });
  return { client, transport };
}

async function registerHttp(name: string): Promise<string> {
  const res = await fetch(`${ctx.baseUrl}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
    body: JSON.stringify({ name }),
  });
  return ((await res.json()) as { token: string }).token;
}

async function userState(name: string): Promise<{ online: boolean; hasActivePoll: boolean } | undefined> {
  const body = (await (await fetch(`${ctx.baseUrl}/users`)).json()) as {
    users: Array<{ name: string; online: boolean; hasActivePoll: boolean }>;
  };
  return body.users.find((u) => u.name === name);
}

describe("DeliveryCursor", () => {
  it("commits a served batch on the next call when the result was delivered", () => {
    const c = new DeliveryCursor(0);
    c.served(12);
    expect(c.committed).toBe(0); // not yet — the station has not been shown to have it
    c.settle();
    expect(c.committed).toBe(12);
  });

  it("keeps the cursor put when the transport could not write the result", () => {
    const c = new DeliveryCursor(3);
    c.served(12);
    c.responseFailed();
    c.settle();
    // The station never saw that batch, so the next poll must serve it again. Committing here
    // is the silent-loss bug the whole mechanism exists to close.
    expect(c.committed).toBe(3);
  });

  it("does not carry a send failure forward past the batch it belongs to", () => {
    const c = new DeliveryCursor(0);
    c.served(5);
    c.responseFailed();
    c.settle();
    expect(c.committed).toBe(0);
    c.served(9);
    c.settle();
    expect(c.committed).toBe(9);
  });

  it("adopts a fresh high-water mark on join, discarding anything uncommitted", () => {
    const c = new DeliveryCursor(0);
    c.served(4);
    c.reset(100);
    c.settle();
    expect(c.committed).toBe(100);
  });
});

describe("resolveMcpSessionIdleMs", () => {
  it("defaults comfortably above the maximum standby window", () => {
    // The invariant: the idle window must exceed the longest standby a station may request,
    // or a station 20 minutes into a legitimate wait loses its session and its callsign.
    expect(resolveMcpSessionIdleMs({})).toBeGreaterThanOrEqual(2 * 900_000);
  });

  it("still clears the max window when that window is raised", () => {
    const idle = resolveMcpSessionIdleMs({ WALKIE_TALKIE_MAX_POLL_WINDOW_MS: "3600000" });
    expect(idle).toBeGreaterThan(3_600_000);
  });

  it("takes an explicit override, and falls back on a bad one", () => {
    expect(resolveMcpSessionIdleMs({ WALKIE_TALKIE_MCP_SESSION_IDLE_MS: "120000" })).toBe(120_000);
    expect(resolveMcpSessionIdleMs({ WALKIE_TALKIE_MCP_SESSION_IDLE_MS: "nonsense" })).toBeGreaterThan(0);
  });
});

describe("the idle sweeper", () => {
  it("does not close a session with a request in flight, however old its last activity", async () => {
    const rx = await connectAndJoin("sweep-rx");

    const standby = rx.client.callTool({ name: "radio_standby", arguments: { wait_seconds: 30 } });
    await new Promise((r) => setTimeout(r, 150));

    // idleMs of -1 makes every session look infinitely stale. Only inFlight can save one, and
    // that is exactly the guarantee a station mid-standby depends on.
    sweepMcpSessions(-1);
    expect(mcpSessionCount()).toBe(1);
    expect(await userState("sweep-rx")).toMatchObject({ online: true, hasActivePoll: true });

    // Sent over the plain HTTP API so the sender is not itself an MCP session the sweep above
    // would have closed. The standby must still complete normally.
    const tx = await registerHttp("sweep-tx");
    const sent = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tx}` },
      body: JSON.stringify({ to: "@sweep-rx", content: "survived" }),
    });
    expect(sent.status).toBe(200);

    const result = (await standby) as { content: Array<{ text?: string }> };
    expect(result.content.map((c) => c.text).join("\n")).toContain("survived");

    await rx.client.close();
  }, 20_000);

  it("closes an idle session and puts its station into the stale grace", async () => {
    const s = await connectAndJoin("sweep-idle");
    expect(await userState("sweep-idle")).toMatchObject({ online: true });
    const before = mcpSessionCount();
    expect(before).toBeGreaterThan(0);

    expect(sweepMcpSessions(-1)).toBeGreaterThan(0);
    expect(mcpSessionCount()).toBeLessThan(before);

    // Offline, but still REGISTERED: a swept session gets the same grace a dropped poll socket
    // does, so a station that restarts quickly can reclaim its own callsign rather than find it
    // taken. Immediate unregistration here would hand the name to whoever asked next.
    const state = await userState("sweep-idle");
    expect(state).toBeDefined();
    expect(state?.online).toBe(false);

    await s.client.close();
  }, 20_000);
});

describe("DELETE /mcp", () => {
  it("marks the station offline exactly as a dropped poll socket does", async () => {
    const s = await connectAndJoin("delete-me");
    expect(await userState("delete-me")).toMatchObject({ online: true });

    const sessionId = s.transport.sessionId;
    expect(sessionId).toBeTruthy();
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ctx.joinToken}`, "Mcp-Session-Id": sessionId as string },
    });
    expect(res.status).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 100));

    const state = await userState("delete-me");
    expect(state).toBeDefined();
    expect(state?.online).toBe(false);

    // And the session is gone, so the callsign is free for the same station to reclaim.
    const again = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.joinToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId as string,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(again.status).toBe(404);

    await s.client.close();
  }, 20_000);
});
