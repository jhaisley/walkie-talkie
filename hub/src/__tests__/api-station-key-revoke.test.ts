import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbListStationKeys } from "../db.js";
import {
  enrollStation,
  registerUser,
  registerWith,
  startTestServer,
  stopTestServer,
  type TestContext,
} from "./helpers/server-harness.js";

let ctx: TestContext;

/**
 * The stale reaper is DISABLED for this whole file.
 *
 * That is the point of the file, not an incidental setting. Revocation flips revoked_at, but the
 * session token minted at /register never re-consults the key — so without an explicit kick a
 * revoked station keeps sending and polling until something else collects it. With the default
 * 30s grace that "something else" masks the bug; with WALKIE_TALKIE_STALE_GRACE_MS <= 0 (which is
 * exactly what a sleep-prone host is advised to set) nothing ever collects it at all. Running
 * with the reaper off means a passing assertion here can only be the revoke handler's own work.
 */
beforeAll(async () => {
  ctx = await startTestServer({ staleGraceMs: 0 });
});

afterAll(async () => {
  await stopTestServer(ctx);
});

function revoke(id: unknown): Promise<Response> {
  return fetch(`${ctx.baseUrl}/admin-station-key-revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.adminToken}` },
    body: JSON.stringify({ id }),
  });
}

async function send(token: string): Promise<number> {
  const res = await fetch(`${ctx.baseUrl}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: "@all", content: "still here" }),
  });
  return res.status;
}

function activeKeyId(callsign: string): string {
  const id = dbListStationKeys().find((k) => k.callsign === callsign && k.revoked_at === null)?.id;
  if (!id) throw new Error(`no active key for ${callsign}`);
  return id;
}

describe("/admin-station-key-revoke", () => {
  it("ends the live session immediately, not when the reaper gets round to it", async () => {
    const key = await enrollStation(ctx, "alpha");
    const token = ((await (await registerWith(ctx, key, { name: "alpha" })).json()) as { token: string }).token;
    expect(await send(token)).toBe(200);

    const res = await revoke(activeKeyId("alpha"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kicked: string | null }).kicked).toBe("alpha");

    // No sleep, no grace period: the session token is dead on the next request.
    expect(await send(token)).toBe(401);
    // ...and the callsign is free again.
    const users = (await (await fetch(`${ctx.baseUrl}/users`)).json()) as { users: Array<{ name: string }> };
    expect(users.users.some((u) => u.name === "alpha")).toBe(false);
    // ...and the key itself no longer registers.
    expect((await registerWith(ctx, key, { name: "alpha" })).status).toBe(401);
  });

  it("does not kick a callsign the revoked key was not holding", async () => {
    // "bravo" is registered on the JOIN TOKEN. A key minted for the same callsign is not the
    // credential that session was proven with, so revoking it must not evict a station it has no
    // claim over — revocation ends the session belonging to the key, not everything named alike.
    const token = await registerUser(ctx, "bravo");
    await enrollStation(ctx, "bravo");
    const res = await revoke(activeKeyId("bravo"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kicked: string | null }).kicked).toBeNull();
    expect(await send(token)).toBe(200);
  });

  it("404s an unknown or already-revoked key", async () => {
    await enrollStation(ctx, "charlie");
    const id = activeKeyId("charlie");
    expect((await revoke(id)).status).toBe(200);
    // Revoking twice is not idempotent-success: the second call had nothing to revoke, and
    // reporting success would let an operator believe they had just closed something.
    expect((await revoke(id)).status).toBe(404);
    expect((await revoke("0000000000000000")).status).toBe(404);
  });

  it("requires the admin token, and an id", async () => {
    const unauth = await fetch(`${ctx.baseUrl}/admin-station-key-revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "whatever" }),
    });
    expect(unauth.status).toBe(401);
    expect((await revoke(undefined)).status).toBe(400);
  });
});
