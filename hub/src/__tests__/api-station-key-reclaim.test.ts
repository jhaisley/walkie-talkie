import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  enrollStation,
  registerWith,
  startTestServer,
  stopTestServer,
  type TestContext,
} from "./helpers/server-harness.js";

let ctx: TestContext;

/**
 * The reap grace is disabled throughout. Every assertion here is about a key proving ownership,
 * and a passing result would be worthless if the stale reaper could have freed the callsign in
 * the background instead.
 */
beforeAll(async () => {
  ctx = await startTestServer({ staleGraceMs: 0 });
});

afterAll(async () => {
  await stopTestServer(ctx);
});

async function send(baseUrl: string, token: string): Promise<number> {
  const res = await fetch(`${baseUrl}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: "@all", content: "hi" }),
  });
  return res.status;
}

describe("reclaim with a station key", () => {
  it("takes its own callsign back with no oldToken", async () => {
    // This is the second prize of binding identity: a restarted station does not need a token
    // file, and does not have to be reaped out of its own callsign before it can have it back.
    const key = await enrollStation(ctx, "alpha");

    const first = await registerWith(ctx, key, { name: "alpha" });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { token: string; reclaimed?: boolean };
    expect(firstBody.reclaimed).toBe(false);
    expect(await send(ctx.baseUrl, firstBody.token)).toBe(200);

    const second = await registerWith(ctx, key, { name: "alpha" });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { token: string; reclaimed?: boolean };
    expect(secondBody.reclaimed).toBe(true);
    expect(secondBody.token).not.toBe(firstBody.token);

    // The superseded session token is dead immediately, not after a grace period.
    expect(await send(ctx.baseUrl, firstBody.token)).toBe(401);
    expect(await send(ctx.baseUrl, secondBody.token)).toBe(200);
  });

  it("does not let a DIFFERENT key take a held callsign", async () => {
    const held = await enrollStation(ctx, "bravo");
    expect((await registerWith(ctx, held, { name: "bravo" })).status).toBe(200);

    // Minting a second key for the same callsign is a rotation — the predecessor dies — so the
    // only way to hold a foreign key here is one bound to a different callsign.
    const other = await enrollStation(ctx, "other");
    const res = await registerWith(ctx, other, { name: "bravo" });
    // Bound to "other", not "bravo": refused before ownership is even considered.
    expect(res.status).toBe(403);
  });

  it("does not let the join token take a key-held callsign without the oldToken", async () => {
    const key = await enrollStation(ctx, "charlie");
    expect((await registerWith(ctx, key, { name: "charlie" })).status).toBe(200);
    const res = await registerWith(ctx, ctx.joinToken, { name: "charlie" });
    expect(res.status).toBe(409);
  });

  it("leaves the legacy oldToken path working for join-token stations", async () => {
    // The proof that nothing changed for the live fleet: no key involved, reclaim still hinges
    // entirely on presenting the previous session token.
    const first = await registerWith(ctx, ctx.joinToken, { name: "delta" });
    const firstToken = ((await first.json()) as { token: string }).token;

    const wrong = await registerWith(ctx, ctx.joinToken, { name: "delta", oldToken: "nope" });
    expect(wrong.status).toBe(409);

    const right = await registerWith(ctx, ctx.joinToken, { name: "delta", oldToken: firstToken });
    expect(right.status).toBe(200);
    expect(((await right.json()) as { reclaimed?: boolean }).reclaimed).toBe(true);
  });

  it("lets a key reclaim a callsign that a join-token station is holding only via oldToken", async () => {
    // Mid-migration shape: the station registered on the join token, then reinstalled with a key.
    // The incumbent registration has no keyId, so the key alone is NOT proof — the station must
    // still present its old session token. Being strict here is deliberate: otherwise minting a
    // key would be a way to evict whoever currently holds a name.
    const first = await registerWith(ctx, ctx.joinToken, { name: "echo" });
    const oldToken = ((await first.json()) as { token: string }).token;
    const key = await enrollStation(ctx, "echo");

    expect((await registerWith(ctx, key, { name: "echo" })).status).toBe(409);
    const withOld = await registerWith(ctx, key, { name: "echo", oldToken });
    expect(withOld.status).toBe(200);

    // From here on the registration carries the keyId, so subsequent reclaims need nothing.
    const again = await registerWith(ctx, key, { name: "echo" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { reclaimed?: boolean }).reclaimed).toBe(true);
  });
});
