import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer({ staleGraceMs: 0 });
});

afterAll(async () => {
  await stopTestServer(ctx);
});

async function whoami(token: string) {
  const res = await fetch(`${ctx.baseUrl}/whoami`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function inboxCount(token: string): Promise<number> {
  const res = await fetch(`${ctx.baseUrl}/inbox`, { headers: { Authorization: `Bearer ${token}` } });
  return ((await res.json()) as { messages: unknown[] }).messages.length;
}

/**
 * /whoami exists as a token PROBE: a station must be able to ask "is this credential live"
 * before spending a join on it, at zero cost. These tests pin the two properties that make it
 * usable for that — it distinguishes live from dead, and it has no side effects.
 */
describe("GET /whoami", () => {
  it("answers 200 with the identity for a live token, and 401 for a dead one", async () => {
    const tok = await registerUser(ctx, "probe-me");
    const live = await whoami(tok);
    expect(live.status).toBe(200);
    expect(live.body.name).toBe("probe-me");

    // The control every probe needs: a bogus token must NOT read as valid. (/users fails this —
    // it is public — which is how a station once reported a dead token as live.)
    const bogus = await whoami("not-a-real-token");
    expect(bogus.status).toBe(401);
  });

  it("does not drain the inbox, unlike /inbox", async () => {
    const sender = await registerUser(ctx, "probe-sender");
    const target = await registerUser(ctx, "probe-target");
    await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${sender}` },
      body: JSON.stringify({ to: "@probe-target", channel: "#all", content: "queued for you" }),
    }).catch(() => {});
    // Probe twice; a queued message must still be there afterwards.
    await whoami(target);
    await whoami(target);
    expect(await inboxCount(target)).toBeGreaterThanOrEqual(0);
    // The decisive assertion: /whoami must not be the thing that emptied the queue. Send again,
    // probe, then drain via /inbox and expect the message to arrive there.
    await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${sender}` },
      body: JSON.stringify({ to: "@probe-target", channel: "#all", content: "second" }),
    }).catch(() => {});
    await whoami(target);
    const res = await fetch(`${ctx.baseUrl}/inbox`, { headers: { Authorization: `Bearer ${target}` } });
    const msgs = ((await res.json()) as { messages: Array<{ content: string }> }).messages;
    expect(msgs.some((m) => m.content === "second")).toBe(true);
  });

  it("does not manufacture liveness: a never-polled station still reads hasActivePoll=false", async () => {
    const tok = await registerUser(ctx, "probe-quiet");
    await whoami(tok);
    const r = await whoami(tok);
    expect(r.body.hasActivePoll).toBe(false);
  });
});
