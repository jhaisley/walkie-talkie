import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { restartTestServer, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer({ staleGraceMs: 0 });
});
afterAll(async () => {
  await stopTestServer(ctx);
});

async function join(name: string, oldToken?: string) {
  const res = await fetch(`${ctx.baseUrl}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
    body: JSON.stringify(oldToken ? { name, oldToken } : { name }),
  });
  return { status: res.status, body: (await res.json()) as { token?: string; reclaimed?: boolean; error?: string } };
}
async function whoisAdmin(name: string) {
  const res = await fetch(`${ctx.baseUrl}/whois?name=${name}`, {
    headers: { Authorization: `Bearer ${ctx.adminToken}` },
  });
  return (await res.json()) as { unclaimed?: boolean };
}

/**
 * The state a hub DEPLOY creates for every hosted station, and the one no experiment against a
 * running hub can manufacture: a registration restored from the DB at boot that nobody has
 * authenticated as since. `unclaimed` is set at exactly one site (auth.ts, inside the restore),
 * and every row created through /register is claimed at once (server.ts markClaimed). So a 2x2
 * over rows made by /register can never reach this cell — which is why a fleet-wide STOP was
 * called on the deploy on the strength of such a 2x2. This test reaches it the real way.
 */
describe("bare reclaim of a restart-restored registration", () => {
  it("a hosted station whose session died in the restart rejoins BARE and reclaims its own row", async () => {
    const first = await join("survivor");
    expect(first.status).toBe(200);
    const preRestartToken = first.body.token as string;

    ctx = await restartTestServer(ctx);

    // The deploy's exact state: row restored, unclaimed, and the station has NO token to offer —
    // a hosted client keeps its token only in the session the restart just destroyed.
    expect((await whoisAdmin("survivor")).unclaimed).toBe(true);
    const bare = await join("survivor");
    expect(bare.status).toBe(200);
    expect(bare.body.reclaimed).toBe(true);
    expect(bare.body.token).not.toBe(preRestartToken); // a fresh token, as a reclaim mints one
  });

  it("the window closes on that join: a second bare join is refused", async () => {
    const second = await join("survivor");
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("already registered");
  });

  it("an operator /whois probe does NOT close another station's window", async () => {
    await join("probed");
    ctx = await restartTestServer(ctx);
    expect((await whoisAdmin("probed")).unclaimed).toBe(true);
    await whoisAdmin("probed"); // admin route: must not markClaimed
    await whoisAdmin("probed");
    expect((await whoisAdmin("probed")).unclaimed).toBe(true);
    // ...so the station itself can still take it back bare.
    expect((await join("probed")).body.reclaimed).toBe(true);
  });

  it("the explicit oldToken route still works too, and reaches the gate as oldToken", async () => {
    const first = await join("explicit");
    const tok = first.body.token as string;
    ctx = await restartTestServer(ctx);
    // Proves the client's `token` argument, sent as body.oldToken, is the field the gate reads.
    expect((await join("explicit", tok)).body.reclaimed).toBe(true);
  });
});
