import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbListStationKeys } from "../db.js";
import { registerWith, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer({ staleGraceMs: 0 });
});

afterAll(async () => {
  await stopTestServer(ctx);
});

function mint(body: Record<string, unknown>, token = ctx.adminToken): Promise<Response> {
  return fetch(`${ctx.baseUrl}/admin-station-key-create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function enroll(code: unknown): Promise<Response> {
  return fetch(`${ctx.baseUrl}/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

describe("/admin-station-key-create", () => {
  it("requires the admin token", async () => {
    expect((await mint({ callsign: "alpha" }, "wrong-token")).status).toBe(401);
    const unauth = await fetch(`${ctx.baseUrl}/admin-station-key-create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callsign: "alpha" }),
    });
    expect(unauth.status).toBe(401);
  });

  it("returns a code, never a key", async () => {
    const res = await mint({ callsign: "alpha" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBeTypeOf("string");
    expect(body.callsign).toBe("alpha");
    expect(body.expiresAt).toBeTypeOf("number");
    // The secret never reaches the operator's browser: it is minted at redemption and shown only
    // to the machine that redeems it.
    expect(JSON.stringify(body)).not.toContain("wtk_");
  });

  it("rejects a missing or malformed callsign", async () => {
    expect((await mint({})).status).toBe(400);
    expect((await mint({ callsign: "has spaces" })).status).toBe(400);
    expect((await mint({ callsign: "bad/slash" })).status).toBe(400);
  });
});

describe("/admin-station-keys", () => {
  it("never exposes a secret or a hash", async () => {
    await enroll(((await (await mint({ callsign: "listed" })).json()) as { code: string }).code);
    const res = await fetch(`${ctx.baseUrl}/admin-station-keys`, {
      headers: { Authorization: `Bearer ${ctx.adminToken}` },
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).toContain("listed");
    expect(raw).not.toContain("secret_hash");
    expect(raw).not.toContain("wtk_");
  });

  it("requires the admin token", async () => {
    expect((await fetch(`${ctx.baseUrl}/admin-station-keys`)).status).toBe(401);
  });
});

describe("/enroll", () => {
  it("returns a working key exactly once", async () => {
    const { code } = (await (await mint({ callsign: "bravo" })).json()) as { code: string };

    const first = await enroll(code);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { key: string; callsign: string; hubUrl: string };
    expect(body.key.startsWith("wtk_")).toBe(true);
    expect(body.callsign).toBe("bravo");
    expect(body.hubUrl).toContain("127.0.0.1");
    expect((await registerWith(ctx, body.key, { name: "bravo" })).status).toBe(200);

    // Second redemption of the same code: refused, and NOTHING minted. The conditional UPDATE is
    // the guard — a read-then-write here would hand out two live identities for one callsign.
    const before = dbListStationKeys().filter((k) => k.callsign === "bravo").length;
    const second = await enroll(code);
    expect(second.status).toBe(403);
    expect(dbListStationKeys().filter((k) => k.callsign === "bravo")).toHaveLength(before);
  });

  it("refuses an expired code", async () => {
    // 0.002 minutes = 120ms. A code left on a screen or in a chat log has to become worthless on
    // its own, without anyone remembering to clean it up.
    const { code } = (await (await mint({ callsign: "charlie", ttlMinutes: 0.002 })).json()) as { code: string };
    await new Promise((r) => setTimeout(r, 250));
    expect((await enroll(code)).status).toBe(403);
    expect(dbListStationKeys().filter((k) => k.callsign === "charlie")).toHaveLength(0);
  });

  it("falls back to the default ttl for a nonsensical one", async () => {
    for (const ttlMinutes of [-5, 0, Number.NaN, "soon"]) {
      const res = await mint({ callsign: `ttl${String(ttlMinutes).replace(/[^a-z0-9]/gi, "")}`, ttlMinutes });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { expiresAt: number };
      // 30 minutes, not zero: a bad number must not silently produce a pre-expired code.
      expect(body.expiresAt).toBeGreaterThan(Date.now() + 25 * 60_000);
    }
  });

  it("refuses an unknown code without saying why", async () => {
    const res = await enroll("definitely-not-a-code");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    // One message for unknown / spent / expired. Distinguishing them would confirm to a grinder
    // that a code exists, which is the only thing worth learning from a miss.
    expect(body.error).toBe("Invalid, expired, or already-redeemed enrollment code");
  });

  it("rejects a missing code with 400", async () => {
    const res = await fetch(`${ctx.baseUrl}/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rotates: a code for a callsign with an active key leaves exactly one live row", async () => {
    const firstCode = ((await (await mint({ callsign: "delta" })).json()) as { code: string }).code;
    const firstKey = ((await (await enroll(firstCode)).json()) as { key: string }).key;
    expect((await registerWith(ctx, firstKey, { name: "delta" })).status).toBe(200);

    const secondCode = ((await (await mint({ callsign: "delta" })).json()) as { code: string }).code;
    const secondKey = ((await (await enroll(secondCode)).json()) as { key: string }).key;

    const live = dbListStationKeys().filter((k) => k.callsign === "delta" && k.revoked_at === null);
    expect(live).toHaveLength(1);
    // The displaced key is dead as a credential...
    expect((await registerWith(ctx, firstKey, { name: "delta" })).status).toBe(401);
    // ...and the session it was holding was ended with it, rather than surviving until the reaper
    // (which is disabled here) would have got round to it.
    const users = (await (await fetch(`${ctx.baseUrl}/users`)).json()) as { users: Array<{ name: string }> };
    expect(users.users.some((u) => u.name === "delta")).toBe(false);
    expect((await registerWith(ctx, secondKey, { name: "delta" })).status).toBe(200);
  });
});
