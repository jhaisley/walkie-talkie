import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllMcpSessions } from "../mcp.js";
import { startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

/**
 * End-to-end coverage of the hub-hosted MCP endpoint, driven by the real SDK client over
 * Streamable HTTP rather than by poking internals — the point of the change is that a station's
 * CLI can point at http://hub:9559/mcp and get the same radio, so the test has to be a client.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  // MCP clients hold a standalone GET SSE stream open, which keeps the socket alive and makes
  // a bare server.close() hang. Real shutdown does the same two things (hub/src/index.ts).
  await closeAllMcpSessions(0);
  ctx.server.closeAllConnections();
  await stopTestServer(ctx);
});

interface RadioClient {
  client: Client;
  transport: StreamableHTTPClientTransport;
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

async function connect(token = ctx.joinToken): Promise<RadioClient> {
  const transport = new StreamableHTTPClientTransport(new URL(`${ctx.baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test-station", version: "1.0.0" });
  await client.connect(transport);
  return {
    client,
    transport,
    async call(name, args = {}) {
      const res = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const text = res.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      return { text, isError: res.isError === true };
    },
    async close() {
      await client.close();
    },
  };
}

describe("/mcp auth", () => {
  it("refuses a POST with no join token and creates no session", async () => {
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });

  it("refuses a wrong join token on every method", async () => {
    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await fetch(`${ctx.baseUrl}/mcp`, {
        method,
        headers: { Authorization: "Bearer nope", Accept: "application/json, text/event-stream" },
      });
      expect(res.status).toBe(401);
    }
  });

  it("answers an unknown session id with 404 so the client reinitializes", async () => {
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.joinToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": "00000000-0000-0000-0000-000000000000",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(404);
  });
});

describe("/mcp sessions", () => {
  it("exposes the radio tools, including radio_send_image", async () => {
    const a = await connect();
    const tools = await a.client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toContain("radio_join");
    expect(names).toContain("radio_standby");
    // Registered on BOTH transports on purpose: a tool that appears and disappears depending
    // on which transport you connected over is the confusion this change exists to remove.
    expect(names).toContain("radio_send_image");
    expect(names).toHaveLength(12);
    await a.close();
  });

  it("keeps two sessions' registrations apart", async () => {
    const a = await connect();
    const b = await connect();

    const ja = await a.call("radio_join", { name: "mcp-alpha" });
    expect(ja.isError).toBe(false);
    expect(ja.text).toContain('Registered as "mcp-alpha"');
    // The build marker is a contract for fleet tooling, and must say the HUB is serving it.
    expect(ja.text).toMatch(/\[client hub-[^\]]+\]$/);

    // Session B has not joined: its own guard must still fire, which is the direct regression
    // test for the module-global token that a single-process server would have shared.
    const before = await b.call("radio_channels");
    expect(before.isError).toBe(true);
    expect(before.text).toBe("Not on the air. Use radio_join first.");

    const jb = await b.call("radio_join", { name: "mcp-bravo" });
    expect(jb.text).toContain('Registered as "mcp-bravo"');

    const channels = await a.call("radio_channels");
    expect(channels.text).toContain("mcp-alpha");
    expect(channels.text).toContain("mcp-bravo");

    await a.close();
    await b.close();
  });

  it("refuses a callsign a live session already holds, and the holder keeps working", async () => {
    const a = await connect();
    await a.call("radio_join", { name: "mcp-dup" });

    const b = await connect();
    const clash = await b.call("radio_join", { name: "mcp-dup" });
    expect(clash.isError).toBe(true);
    expect(clash.text).toContain('User "mcp-dup" is already registered');

    // The first session is untouched.
    const still = await a.call("radio_channels");
    expect(still.isError).toBe(false);
    expect(still.text).toContain("mcp-dup");

    await a.close();
    await b.close();
  });

  it("delivers a message to an in-flight radio_standby without waiting out the window", async () => {
    const a = await connect();
    const b = await connect();
    await a.call("radio_join", { name: "mcp-tx" });
    await b.call("radio_join", { name: "mcp-rx" });

    // 60s window; if delivery needed the window to elapse this test would time out.
    const standby = b.call("radio_standby", { wait_seconds: 60 });
    await new Promise((r) => setTimeout(r, 150));

    const users = (await (await fetch(`${ctx.baseUrl}/users`)).json()) as {
      users: Array<{ name: string; online: boolean; hasActivePoll: boolean }>;
    };
    const rx = users.users.find((u) => u.name === "mcp-rx");
    // Proves awaitPoll registered in the SAME pendingPolls map the dashboard's liveness column
    // and /kick both read. A parallel registry would have shown every remote station as dead.
    expect(rx?.online).toBe(true);
    expect(rx?.hasActivePoll).toBe(true);

    const sent = await a.call("radio_over", { to: "@mcp-rx", message: "hello over the air" });
    expect(sent.isError).toBe(false);

    const got = await standby;
    expect(got.text).toContain("hello over the air");

    await a.close();
    await b.close();
  }, 20_000);

  it("does not re-deliver a batch the station actually received", async () => {
    const a = await connect();
    const b = await connect();
    await a.call("radio_join", { name: "mcp-alo-tx" });
    await b.call("radio_join", { name: "mcp-alo-rx" });

    const standby = b.call("radio_standby", { wait_seconds: 60 });
    await new Promise((r) => setTimeout(r, 100));
    await a.call("radio_over", { to: "@mcp-alo-rx", message: "at-least-once" });
    const first = await standby;
    expect(first.text).toContain("at-least-once");

    // The serve-by-cursor path does NOT remove anything from the delivery log, so the guard
    // against replaying forever is the commit — a healthy station must see the batch once.
    const second = await b.call("radio_standby", { wait_seconds: 2 });
    expect(second.text).toBe("No new messages (poll timed out). Try again.");
    const third = await b.call("radio_check");
    expect(third.text).toBe("No new messages.");

    await a.close();
    await b.close();
  }, 30_000);

  it("cancelling a standby leaves the station registered, online and reachable", async () => {
    const a = await connect();
    const b = await connect();
    await a.call("radio_join", { name: "mcp-cancel-tx" });
    await b.call("radio_join", { name: "mcp-cancel-rx" });

    // Abort one tool call — a station changing its mind, NOT a station dying. The HTTP poll
    // path cannot tell those apart, and conflating them auto-unregistered the whole fleet once.
    const ac = new AbortController();
    const cancelled = b.client
      .callTool({ name: "radio_standby", arguments: { wait_seconds: 60 } }, undefined, { signal: ac.signal })
      .catch((e) => e as Error);
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await cancelled;
    await new Promise((r) => setTimeout(r, 150));

    const users = (await (await fetch(`${ctx.baseUrl}/users`)).json()) as {
      users: Array<{ name: string; online: boolean }>;
    };
    const rx = users.users.find((u) => u.name === "mcp-cancel-rx");
    expect(rx).toBeDefined();
    expect(rx?.online).toBe(true);

    // And it is still reachable: the registration survived, so a later send still lands.
    const sent = await a.call("radio_over", { to: "@mcp-cancel-rx", message: "still here" });
    expect(sent.isError).toBe(false);
    const check = await b.call("radio_check");
    expect(check.text).toContain("still here");

    await a.close();
    await b.close();
  }, 20_000);
});

describe("/mcp capability gating", () => {
  it("refuses a local file path without touching the hub's disk", async () => {
    const a = await connect();
    await a.call("radio_join", { name: "mcp-img" });
    const res = await a.call("radio_send_image", { to: "@all", source: "/etc/hostname" });
    expect(res.isError).toBe(true);
    expect(res.text).toBe(
      "This station is connected to a remote radio, so it cannot read files from your disk. " +
        "Read the file yourself and pass it to radio_over as image_data + image_mime_type, or " +
        "supply an http(s) URL if your hub allows it.",
    );
    await a.close();
  });

  it("refuses an http(s) source when remote fetch is not opted in", async () => {
    const a = await connect();
    await a.call("radio_join", { name: "mcp-img2" });
    const res = await a.call("radio_send_image", {
      to: "@all",
      source: "http://169.254.169.254/computeMetadata/v1/",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("does not fetch remote URLs");
    await a.close();
  });

  it("radio_token reports the hub build and no local listener script", async () => {
    const a = await connect();
    await a.call("radio_join", { name: "mcp-tok" });
    const res = await a.call("radio_token");
    const payload = JSON.parse(res.text) as {
      hubUrl: string;
      clientBuild: string;
      token: string;
      waitScript: string | null;
      waitScriptNote: string;
    };
    expect(payload.waitScript).toBeNull();
    expect(payload.clientBuild.startsWith("hub-")).toBe(true);
    expect(payload.token).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.hubUrl).toContain("127.0.0.1");
    // Distinct from the local "no script on this station" note: it is the HUB that has none,
    // and a hub-side script would be no use to the station anyway.
    expect(payload.waitScriptNote).toContain("hosted by the hub");
    await a.close();
  });
});

describe("/mcp coexistence with the HTTP API", () => {
  it("leaves /register, /send, /poll and /users behaving normally with a session open", async () => {
    const a = await connect();
    await a.call("radio_join", { name: "mcp-mixed" });

    const reg = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ name: "http-mixed" }),
    });
    expect(reg.status).toBe(200);
    const { token } = (await reg.json()) as { token: string };

    // An ordinary HTTP station can send to a hub-hosted one and vice versa: one hub, one
    // callsign namespace, whichever transport a station happens to use.
    const send = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: "@mcp-mixed", content: "from the http side" }),
    });
    expect(send.status).toBe(200);

    const got = await a.call("radio_check");
    expect(got.text).toContain("from the http side");

    await a.close();
  }, 20_000);
});
