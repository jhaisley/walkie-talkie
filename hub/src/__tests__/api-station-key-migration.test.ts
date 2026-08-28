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
 * The migration window: a callsign whose CURRENT registration was made with the shared join token,
 * being re-registered by a station that has since been enrolled with a key.
 *
 * This is the case the two proofs do not obviously cover, and it is the only case that actually
 * happens during a rollout. provenByKey cannot fire — it needs `incumbent.keyId`, and a join-token
 * incumbent has none. So the station must fall back to the legacy oldToken proof, which means the
 * client MUST keep offering its stored token even once it holds a key. An earlier version of the
 * client deliberately withheld it on the reasoning that "the key is the proof", which produced a
 * permanent 409 on the station's own callsign — unrecoverable without an operator kick when the
 * reap grace is disabled, the setting this hub's own docs recommend for sleep-prone hosts.
 */
beforeAll(async () => {
  // Grace disabled: if the reaper could free the callsign in the background, a pass here would
  // prove nothing about the proofs themselves.
  ctx = await startTestServer({ staleGraceMs: 0 });
});

afterAll(async () => {
  await stopTestServer(ctx);
});

describe("station key migration over a join-token incumbent", () => {
  it("lets a newly-keyed station reclaim its own callsign using the legacy oldToken", async () => {
    const first = await registerWith(ctx, ctx.joinToken, { name: "migrating" });
    expect(first.status).toBe(200);
    const oldToken = ((await first.json()) as { token: string }).token;

    const key = await enrollStation(ctx, "migrating");

    // The incumbent has no keyId, so the key alone cannot prove ownership here.
    const withoutToken = await registerWith(ctx, key, { name: "migrating" });
    expect(withoutToken.status).toBe(409);

    // Offering the persisted token is what carries the station across.
    const withToken = await registerWith(ctx, key, { name: "migrating", oldToken });
    expect(withToken.status).toBe(200);
    const fresh = (await withToken.json()) as { token: string };
    expect(fresh.token).toBeTruthy();
    expect(fresh.token).not.toBe(oldToken);
  });

  it("uses the key alone once the incumbent registration was itself made with it", async () => {
    const key = await enrollStation(ctx, "settled");
    const first = await registerWith(ctx, key, { name: "settled" });
    expect(first.status).toBe(200);

    // Now the incumbent carries a keyId, so no token is needed — the post-migration steady state.
    const again = await registerWith(ctx, key, { name: "settled" });
    expect(again.status).toBe(200);
  });
});
