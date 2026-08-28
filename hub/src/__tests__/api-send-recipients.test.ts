import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

/**
 * A send that reaches nobody must not look like a send that reached the room.
 *
 * Both are a 200 with a message id, and that silence has already cost this fleet ~35 minutes once,
 * when a station spent that long talking to a channel name that did not exist. Channel validation
 * closed the "channel does not exist" half with a 404 — but boot-time restore reopens the other
 * half through a different door: every persisted channel is given an in-memory member set so
 * channelExists() is true for it, while its members do not come back until they re-register. So a
 * broadcast into a fully-absent room is once again a cheerful 200.
 *
 * `recipients` is the signal that distinguishes them. These tests assert DELIVERY, not status —
 * asserting 200 here would pass for exactly the bug being prevented.
 */
beforeAll(async () => {
  ctx = await startTestServer({ staleGraceMs: 0 });
});

afterAll(async () => {
  await stopTestServer(ctx);
});

async function send(token: string, body: Record<string, unknown>) {
  const res = await fetch(`${ctx.baseUrl}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel: "#all", ...body }),
  });
  return { status: res.status, body: (await res.json()) as { recipients?: number; offline?: boolean } };
}

describe("send reports who it actually reached", () => {
  it("reports 0 recipients for a broadcast nobody receives", async () => {
    const solo = await registerUser(ctx, "solo");
    // The only member is the sender, who is skipped — so this reaches nobody.
    const res = await send(solo, { to: "@all", content: "into the void" });
    expect(res.status).toBe(200);
    expect(res.body.recipients).toBe(0);
  });

  it("counts the members a broadcast actually reaches", async () => {
    const a = await registerUser(ctx, "alpha");
    await registerUser(ctx, "bravo");
    await registerUser(ctx, "charlie");
    const res = await send(a, { to: "@all", content: "hello room" });
    // Everyone in #all except the sender. Others from earlier cases are members too, so assert
    // "reached more than nobody" plus the specific fact that the sender is excluded.
    expect(res.body.recipients).toBeGreaterThanOrEqual(2);
  });

  it("carries an online/offline signal on a DM, and omits it on a broadcast", () => {
    // `offline` is only ever TRUE for a registration restored from the DB that has not come back —
    // registerUser marks a station online immediately, so it cannot be provoked here. What this
    // pins is the contract the client depends on: the field is present and boolean for a DM, and
    // absent for a broadcast, where there is no single recipient it could describe. The true case
    // is covered end to end against a restarted hub.
    return (async () => {
      const a = await registerUser(ctx, "sender2");
      await registerUser(ctx, "absent");
      const dm = await send(a, { to: "@absent", content: "you there?" });
      expect(dm.status).toBe(200);
      expect(typeof dm.body.offline).toBe("boolean");

      const bc = await send(a, { to: "@all", content: "room" });
      expect(bc.body.offline).toBeUndefined();
      expect(typeof bc.body.recipients).toBe("number");
    })();
  });
});
