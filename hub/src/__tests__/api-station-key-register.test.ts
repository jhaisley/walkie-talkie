import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbListStationKeys } from "../db.js";
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

describe("/register with a station key", () => {
  it("registers under the callsign the key is bound to", async () => {
    const key = await enrollStation(ctx, "alpha");
    const res = await registerWith(ctx, key, { name: "alpha" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; token: string };
    expect(body.name).toBe("alpha");
    expect(body.token).toBeTruthy();
  });

  it("registers with no name in the body at all", async () => {
    // The key already says who this is. Once the remote transport lands, radio_join degrades to
    // exactly this: a confirmation, with the identity coming from the credential.
    const key = await enrollStation(ctx, "nameless");
    const res = await registerWith(ctx, key, {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("nameless");
  });

  it("treats an empty name as an absence, not a disagreement", async () => {
    // Answering `Key is bound to "x", not ""` would be a baffling 403 for a client that simply
    // did not send a name.
    const key = await enrollStation(ctx, "blankname");
    const res = await registerWith(ctx, key, { name: "   " });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("blankname");
  });

  it("rejects a body name that disagrees with the key, naming both", async () => {
    // Rejecting beats overriding: a station whose transcript says "impostor" while the hub logs
    // it as "bravo" is a far worse failure than an error the operator can read.
    const key = await enrollStation(ctx, "bravo");
    const res = await registerWith(ctx, key, { name: "impostor" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("bravo");
    expect(body.error).toContain("impostor");
  });

  it("ignores a self-declared bridge role and uses the key's", async () => {
    // role was caller-chosen, and router.ts notifyBridges() fans every join/leave event to every
    // holder of "bridge" — so a shared-token holder could subscribe to the fleet's membership
    // feed just by asking. With a key, the role comes from the row.
    const key = await enrollStation(ctx, "charlie", "agent");
    const res = await registerWith(ctx, key, { name: "charlie", role: "bridge" });
    expect(res.status).toBe(200);
    const users = (await (await fetch(`${ctx.baseUrl}/users`)).json()) as {
      users: Array<{ name: string; role: string }>;
    };
    expect(users.users.find((u) => u.name === "charlie")?.role).toBe("agent");
  });

  it("honours a bridge role that IS on the key", async () => {
    // The slack bridge's key must be minted this way or it silently demotes to agent and stops
    // receiving USER_JOINED/USER_LEFT.
    const key = await enrollStation(ctx, "slackbridge", "bridge");
    const res = await registerWith(ctx, key, { name: "slackbridge" });
    expect(res.status).toBe(200);
    const users = (await (await fetch(`${ctx.baseUrl}/users`)).json()) as {
      users: Array<{ name: string; role: string }>;
    };
    expect(users.users.find((u) => u.name === "slackbridge")?.role).toBe("bridge");
  });

  it("401s a revoked key", async () => {
    const key = await enrollStation(ctx, "delta");
    const id = dbListStationKeys().find((k) => k.callsign === "delta" && k.revoked_at === null)?.id;
    expect(id).toBeTruthy();
    const revoke = await fetch(`${ctx.baseUrl}/admin-station-key-revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.adminToken}` },
      body: JSON.stringify({ id }),
    });
    expect(revoke.status).toBe(200);
    // Dispatch no longer accepts it as either credential, so this is the plain "not authorised".
    const res = await registerWith(ctx, key, { name: "delta" });
    expect(res.status).toBe(401);
  });

  it("401s a key with a forged secret", async () => {
    const key = await enrollStation(ctx, "echo");
    const forged = `${key.slice(0, key.lastIndexOf("_") + 1)}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const res = await registerWith(ctx, forged, { name: "echo" });
    expect(res.status).toBe(401);
  });

  it("stamps last_used_at on register, and only on register", async () => {
    const key = await enrollStation(ctx, "golf");
    const before = dbListStationKeys().find((k) => k.callsign === "golf" && k.revoked_at === null);
    expect(before?.last_used_at).toBeNull();
    const res = await registerWith(ctx, key, { name: "golf" });
    expect(res.status).toBe(200);
    const after = dbListStationKeys().find((k) => k.callsign === "golf" && k.revoked_at === null);
    // This is the field the operator reads to decide whether the fleet has finished migrating.
    expect(after?.last_used_at).toBeTypeOf("number");
  });
});

describe("reserved callsigns", () => {
  it("cannot be issued a key", async () => {
    // Without this the key branch of /register would walk straight past isReservedName, because
    // it never consults it — the reservation would have had a hole exactly the size of a key.
    const res = await fetch(`${ctx.baseUrl}/admin-station-key-create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.adminToken}` },
      body: JSON.stringify({ callsign: "operator" }),
    });
    expect(res.status).toBe(403);
  });
});
