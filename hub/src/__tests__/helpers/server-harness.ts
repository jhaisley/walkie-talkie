import type { Server } from "node:http";
import { resetAuthState } from "../../auth.js";
import { initGeneralChannel, resetChannelState } from "../../channels.js";
import { initDB } from "../../db.js";
import { resetPollingState } from "../../polling.js";
import { restoreFleet } from "../../restore.js";
import { resetRouterState } from "../../router.js";
import { createHubServer, resetEnrollFailureState } from "../../server.js";

export interface TestContext {
  baseUrl: string;
  adminToken: string;
  joinToken: string;
  server: Server;
}

export interface TestServerOptions {
  /**
   * Value for WALKIE_TALKIE_STALE_GRACE_MS, applied before createHubServer reads it.
   * `0` disables the stale reaper — set it when a test must prove that something OTHER than the
   * reaper ended a session, since a passing assertion is meaningless if the reaper could have
   * done the work.
   */
  staleGraceMs?: number;
}

const ADMIN_TOKEN = "test-admin-token";
const JOIN_TOKEN = "test-join-token";

export async function startTestServer(options: TestServerOptions = {}): Promise<TestContext> {
  // Reset in-memory state
  resetAuthState();
  resetChannelState();
  resetEnrollFailureState();

  if (options.staleGraceMs !== undefined) {
    process.env.WALKIE_TALKIE_STALE_GRACE_MS = String(options.staleGraceMs);
  } else {
    delete process.env.WALKIE_TALKIE_STALE_GRACE_MS;
  }

  // Init in-memory DB
  process.env.WALKIE_TALKIE_DB_PATH = ":memory:";
  initDB();
  initGeneralChannel();

  const server = createHubServer(0, ADMIN_TOKEN, JOIN_TOKEN);

  // Wait for server to start listening
  await new Promise<void>((resolve) => {
    server.on("listening", resolve);
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    adminToken: ADMIN_TOKEN,
    joinToken: JOIN_TOKEN,
    server,
  };
}

/**
 * Simulate a hub process restart against the SAME database.
 *
 * The whole point of registration persistence is what survives this, so the simulation has to be
 * honest about what does not: every in-memory map the process owns is cleared (roster, channel
 * member sets, message queues, online/last-seen), and initDB() is deliberately NOT called again —
 * a second initDB() on ":memory:" would hand back a brand-new empty database and the test would
 * be asserting nothing at all.
 *
 * Note that startTestServer does NOT call restoreFleet, so every other suite keeps its
 * empty-roster assumptions (including api-register.test.ts's 409-on-duplicate cases, which only
 * hold while nothing is unclaimed).
 */
export async function restartTestServer(ctx: TestContext, ttlMs?: number): Promise<TestContext> {
  // Close polls before the server: server.close() waits on live connections, and a pending
  // long-poll is one.
  resetPollingState();
  await stopTestServer(ctx);

  resetAuthState();
  resetChannelState();
  resetRouterState();
  initGeneralChannel();
  restoreFleet(ttlMs);

  const server = createHubServer(0, ctx.adminToken, ctx.joinToken);
  await new Promise<void>((resolve) => {
    server.on("listening", resolve);
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return { ...ctx, baseUrl: `http://127.0.0.1:${port}`, server };
}

export async function stopTestServer(ctx: TestContext): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ctx.server.close((err) => (err ? reject(err) : resolve()));
  });
}

export async function registerUser(ctx: TestContext, name: string): Promise<string> {
  const res = await fetch(`${ctx.baseUrl}/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.joinToken}`,
    },
    body: JSON.stringify({ name }),
  });
  const body = (await res.json()) as { token: string };
  return body.token;
}

/** POST /register with an arbitrary bearer credential — a station key, the join token, anything. */
export function registerWith(ctx: TestContext, credential: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${ctx.baseUrl}/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credential}`,
    },
    body: JSON.stringify(body),
  });
}

/** Mint an enrollment code as the operator and redeem it, returning the plaintext station key. */
export async function enrollStation(
  ctx: TestContext,
  callsign: string,
  role: "agent" | "bridge" = "agent",
): Promise<string> {
  const mint = await fetch(`${ctx.baseUrl}/admin-station-key-create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.adminToken}` },
    body: JSON.stringify({ callsign, role }),
  });
  const { code } = (await mint.json()) as { code: string };
  const enroll = await fetch(`${ctx.baseUrl}/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const { key } = (await enroll.json()) as { key: string };
  return key;
}
