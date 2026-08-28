import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbTouchRegistrationSeen } from "../db.js";
import {
  registerUser,
  restartTestServer,
  startTestServer,
  stopTestServer,
  type TestContext,
} from "./helpers/server-harness.js";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await startTestServer();
});

afterEach(async () => {
  await stopTestServer(ctx);
});

function auth(token: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function send(c: TestContext, token: string, to: string, content: string, channel = "#all") {
  return fetch(`${c.baseUrl}/send`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ to, content, channel }),
  });
}

async function rawRegister(c: TestContext, body: Record<string, unknown>) {
  const res = await fetch(`${c.baseUrl}/register`, {
    method: "POST",
    headers: auth(c.joinToken),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function listUsers(c: TestContext) {
  const res = await fetch(`${c.baseUrl}/users`);
  const body = (await res.json()) as {
    users: { name: string; online: boolean; hasActivePoll: boolean; lastSeen: number | null }[];
  };
  return body.users;
}

async function inbox(c: TestContext, token: string) {
  const res = await fetch(`${c.baseUrl}/inbox`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as { messages?: { content: string }[] } };
}

describe("registration persistence across a hub restart", () => {
  it("preserves a station's token, so its pre-restart token is not 401'd", async () => {
    const aliceToken = await registerUser(ctx, "alice");
    await registerUser(ctx, "bob");

    ctx = await restartTestServer(ctx);

    // The whole point of the change. Before it, this was a 401 for every station on every restart
    // — and because the stale reaper also surfaces as a bare 401, it was repeatedly misdiagnosed.
    const res = await send(ctx, aliceToken, "@all", "still here");
    expect(res.status).toBe(200);
  });

  it("THE TRAP: preserves channel membership, so sends still REACH people after a restart", async () => {
    const aliceToken = await registerUser(ctx, "alice");
    const bobToken = await registerUser(ctx, "bob");

    const created = await fetch(`${ctx.baseUrl}/channel-create`, {
      method: "POST",
      headers: auth(aliceToken),
      body: JSON.stringify({ name: "#infra" }),
    });
    expect(created.status).toBe(200);
    const joined = await fetch(`${ctx.baseUrl}/channel-join`, {
      method: "POST",
      headers: auth(bobToken),
      body: JSON.stringify({ channel: "#infra" }),
    });
    expect(joined.status).toBe(200);

    ctx = await restartTestServer(ctx);

    // Every assertion here is on DELIVERY, not on the status code. A 200 proves only that
    // channelExists() was satisfied; the nastier half of this failure is a broadcast that
    // succeeds into an empty member set and reaches nobody, which is exactly how nine messages
    // were lost on this deployment once already.
    expect((await send(ctx, aliceToken, "@all", "infra ping", "#infra")).status).toBe(200);
    expect((await send(ctx, aliceToken, "@all", "all ping", "#all")).status).toBe(200);
    const dm = await send(ctx, aliceToken, "@bob", "direct");
    expect(dm.status).toBe(200); // needs isChannelMember(#all, bob)

    const bobMail = await inbox(ctx, bobToken);
    const got = bobMail.body.messages?.map((m) => m.content) ?? [];
    expect(got).toContain("infra ping"); // needs bob's #infra membership rehydrated
    expect(got).toContain("all ping"); // needs bob's #all membership rehydrated
    expect(got).toContain("direct");
  });

  it("keeps a channel with no restored members alive, so it is not silently un-sendable", async () => {
    // The other half of the rehydration: a channel whose members have all been pruned (or which
    // the operator created and nobody has joined) has no member to re-add it, so without the
    // dbListChannels() sweep channelExists() is false and routeMessage refuses it outright.
    const aliceToken = await registerUser(ctx, "alice");
    const opsCreated = await fetch(`${ctx.baseUrl}/admin-channel-create`, {
      method: "POST",
      headers: auth(ctx.adminToken),
      body: JSON.stringify({ name: "#ops" }),
    });
    expect(opsCreated.status).toBe(200);

    ctx = await restartTestServer(ctx);

    expect((await send(ctx, aliceToken, "@all", "anyone home", "#ops")).status).toBe(200);
  });

  it("reports offline:true on a DM to a station that has not come back yet", async () => {
    const aliceToken = await registerUser(ctx, "alice");
    await registerUser(ctx, "bob");

    ctx = await restartTestServer(ctx);

    // Before persistence, bob's registration was gone and this was a 404 "not connected". Now the
    // message legitimately queues -- but the sender must still be able to tell.
    const res = await send(ctx, aliceToken, "@bob", "you there?");
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ to: "bob", offline: true });
  });

  it("restores a station as OFFLINE, and one authenticated request flips it online", async () => {
    const aliceToken = await registerUser(ctx, "alice");

    ctx = await restartTestServer(ctx);

    // isOnline() is a deny-set, so a restored user that nothing marked offline would show a green
    // dot with no poll and no last-seen -- a station that may never come back looking healthy.
    const before = (await listUsers(ctx)).find((u) => u.name === "alice");
    expect(before).toBeDefined();
    expect(before!.online).toBe(false);
    expect(before!.hasActivePoll).toBe(false);

    expect((await inbox(ctx, aliceToken)).status).toBe(200);

    const after = (await listUsers(ctx)).find((u) => u.name === "alice");
    expect(after!.online).toBe(true);
  });

  it("carries last_seen_at across the restart instead of restamping it to boot time", async () => {
    const aliceToken = await registerUser(ctx, "alice");
    // last_seen_at is NULL until the first authenticated request; make one so there is a stamp.
    await inbox(ctx, aliceToken);

    ctx = await restartTestServer(ctx);

    const alice = (await listUsers(ctx)).find((u) => u.name === "alice");
    expect(alice!.lastSeen).not.toBeNull();
    expect(alice!.lastSeen!).toBeLessThanOrEqual(Date.now());
  });
});

describe("the unclaimed-takeover rule", () => {
  it("lets a restored-but-unseen registration be reclaimed with NO oldToken", async () => {
    const oldToken = await registerUser(ctx, "alice");

    ctx = await restartTestServer(ctx);

    // A station whose client-side token file was wiped has nothing to prove with. Before
    // persistence the restart freed the name and it self-healed; a naive persistence would 409
    // it forever, because no stale timer is ever armed for a registration that never polled.
    const { status, body } = await rawRegister(ctx, { name: "alice" });
    expect(status).toBe(200);
    expect(body.reclaimed).toBe(true);
    expect(body.token).not.toBe(oldToken);

    // The old token is genuinely dead: the takeover minted a new one.
    expect((await inbox(ctx, oldToken)).status).toBe(401);
  });

  it("closes the takeover window at the real station's first authenticated request", async () => {
    const aliceToken = await registerUser(ctx, "alice");

    ctx = await restartTestServer(ctx);

    // markClaimed at the protectedRoutes chokepoint is what makes this a bounded window rather
    // than a permanent hole.
    expect((await inbox(ctx, aliceToken)).status).toBe(200);

    const { status } = await rawRegister(ctx, { name: "alice" });
    expect(status).toBe(409);

    // ...and the real holder can still re-register by proving the token.
    const proved = await rawRegister(ctx, { name: "alice", oldToken: aliceToken });
    expect(proved.status).toBe(200);
    expect(proved.body.reclaimed).toBe(true);
  });

  it("keeps a reserved name unreachable through the unclaimed path", async () => {
    // The dashboard auto-registers "operator" lazily on its first admin message, and it never
    // authenticates as a user, so after a restart it is restored AND permanently unclaimed.
    const adminSend = await fetch(`${ctx.baseUrl}/admin-send`, {
      method: "POST",
      headers: auth(ctx.adminToken),
      body: JSON.stringify({ to: "@all", content: "hello fleet" }),
    });
    expect(adminSend.status).toBe(200);

    ctx = await restartTestServer(ctx);
    expect((await listUsers(ctx)).map((u) => u.name)).toContain("operator");

    // isReservedName has to stay ABOVE the takeover branch, or persistence would have handed
    // every join-token holder a permanent route to the dashboard's identity.
    const { status } = await rawRegister(ctx, { name: "operator" });
    expect(status).toBe(403);
  });
});

describe("what a restart deliberately does NOT preserve", () => {
  it("restores an EMPTY queue: an undelivered message is gone on the legacy poll path", async () => {
    const aliceToken = await registerUser(ctx, "alice");
    const bobToken = await registerUser(ctx, "bob");

    // Alice is not polling, so this only lands in her in-memory queue.
    expect((await send(ctx, bobToken, "@alice", "lost on restart")).status).toBe(200);

    ctx = await restartTestServer(ctx);

    // Pinned on purpose: registration persistence is NOT message persistence. The durable path
    // is the deliveries log (next test), which no deployed client uses yet.
    const res = await fetch(`${ctx.baseUrl}/poll?wait=1000`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(res.status).toBe(204);
  });

  it("still serves a pre-restart delivery on the cursor path", async () => {
    const aliceToken = await registerUser(ctx, "alice");
    const bobToken = await registerUser(ctx, "bob");

    const init = await fetch(`${ctx.baseUrl}/poll?cursor=init`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    const { cursor } = (await init.json()) as { cursor: number };

    expect((await send(ctx, bobToken, "@alice", "durable")).status).toBe(200);

    ctx = await restartTestServer(ctx);

    const res = await fetch(`${ctx.baseUrl}/poll?cursor=${cursor}&wait=1000`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: { content: string }[]; cursor: number };
    expect(body.messages.map((m) => m.content)).toContain("durable");
    expect(body.cursor).toBeGreaterThan(cursor);

    // cursor=init after the restart still reports the real high-water mark, not 0.
    const reinit = await fetch(`${ctx.baseUrl}/poll?cursor=init`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    const { cursor: hw } = (await reinit.json()) as { cursor: number };
    expect(hw).toBeGreaterThanOrEqual(body.cursor);
  });
});

describe("roster hygiene", () => {
  it("does not restore a registration older than the TTL, and frees its callsign", async () => {
    const oldToken = await registerUser(ctx, "alice");
    await registerUser(ctx, "bob");
    // Age alice out. COALESCE(last_seen_at, registered_at) is what the prune compares, so
    // stamping last_seen_at is enough.
    dbTouchRegistrationSeen("alice", Date.now() - 10 * 86_400_000);

    ctx = await restartTestServer(ctx); // default TTL is 7 days

    const names = (await listUsers(ctx)).map((u) => u.name);
    expect(names).not.toContain("alice");
    expect(names).toContain("bob");
    expect((await inbox(ctx, oldToken)).status).toBe(401);

    // The name is free, and a first-time join must not be mislabelled as a reclaim.
    const { status, body } = await rawRegister(ctx, { name: "alice" });
    expect(status).toBe(200);
    expect(body.reclaimed).toBe(false);
  });

  it("keeps everything when the TTL is disabled (<= 0)", async () => {
    await registerUser(ctx, "alice");
    dbTouchRegistrationSeen("alice", Date.now() - 365 * 86_400_000);

    ctx = await restartTestServer(ctx, 0);

    expect((await listUsers(ctx)).map((u) => u.name)).toContain("alice");
  });

  it("drops a kicked station's row, so a restart does not resurrect it", async () => {
    const aliceToken = await registerUser(ctx, "alice");
    const kicked = await fetch(`${ctx.baseUrl}/kick`, {
      method: "POST",
      headers: auth(ctx.adminToken),
      body: JSON.stringify({ name: "alice" }),
    });
    expect(kicked.status).toBe(200);

    ctx = await restartTestServer(ctx);

    expect((await listUsers(ctx)).map((u) => u.name)).not.toContain("alice");
    expect((await inbox(ctx, aliceToken)).status).toBe(401);
    const { status, body } = await rawRegister(ctx, { name: "alice" });
    expect(status).toBe(200);
    expect(body.reclaimed).toBe(false);
  });

  it("drops a station that unregistered itself, but keeps its channel memberships", async () => {
    const aliceToken = await registerUser(ctx, "alice");
    await fetch(`${ctx.baseUrl}/channel-create`, {
      method: "POST",
      headers: auth(aliceToken),
      body: JSON.stringify({ name: "#infra" }),
    });
    const out = await fetch(`${ctx.baseUrl}/unregister`, { method: "POST", headers: auth(aliceToken) });
    expect(out.status).toBe(200);

    ctx = await restartTestServer(ctx);
    expect((await listUsers(ctx)).map((u) => u.name)).not.toContain("alice");

    // unregisterUser must NOT delete channel_members rows -- that asymmetry is what lets a
    // returning station get its channels back.
    const rejoined = await rawRegister(ctx, { name: "alice" });
    expect(rejoined.status).toBe(200);
    const newToken = rejoined.body.token as string;
    expect((await send(ctx, newToken, "@all", "back", "#infra")).status).toBe(200);
  });
});
