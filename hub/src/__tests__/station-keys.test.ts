import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  dbGetActiveStationKeyByCallsign,
  dbGetEnrollment,
  dbGetStationKeyById,
  dbListStationKeys,
  initDB,
} from "../db.js";
import {
  createEnrollment,
  formatStationKey,
  mintStationKey,
  parseStationKey,
  redeemEnrollment,
  resolveStationKeyFromCredential,
  revokeStationKey,
} from "../keys.js";

/** The table is keyed by sha256(code); tests hold the plaintext, so they hash it themselves. */
function dbFindEnrollmentByCode(code: string) {
  return dbGetEnrollment(createHash("sha256").update(code).digest("hex"));
}

beforeAll(() => {
  process.env.WALKIE_TALKIE_DB_PATH = ":memory:";
  initDB();
});

describe("station key format", () => {
  it("mints a wtk_<id>_<secret> that parseStationKey round-trips", () => {
    const { row, secret } = mintStationKey("alpha");
    const parsed = parseStationKey(secret);
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe(row.id);
    expect(secret.startsWith("wtk_")).toBe(true);
    expect(row.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("parses a secret containing base64url's own underscores and hyphens", () => {
    // Regression guard for the obvious-but-wrong implementation: splitting on "_" truncates any
    // secret that contains one, which is roughly half of them, so the bug would be intermittent.
    const raw = formatStationKey("0123456789abcdef", "aa_bb-cc_dd-ee_ffgggggg");
    expect(parseStationKey(raw)).toEqual({ id: "0123456789abcdef", secret: "aa_bb-cc_dd-ee_ffgggggg" });
  });

  it("never persists the plaintext secret", () => {
    const { row, secret } = mintStationKey("bravo");
    const stored = dbGetStationKeyById(row.id);
    expect(stored).toBeDefined();
    // Only a hash is on disk, and the hash is not the credential.
    expect(stored?.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain(parseStationKey(secret)?.secret);
  });
});

describe("resolveStationKey", () => {
  it("accepts a live key", () => {
    const { row, secret } = mintStationKey("charlie");
    expect(resolveStationKeyFromCredential(secret)?.id).toBe(row.id);
  });

  it("rejects the right id with the wrong secret", () => {
    const { row } = mintStationKey("delta");
    const forged = formatStationKey(row.id, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(resolveStationKeyFromCredential(forged)).toBeNull();
  });

  it("rejects an unknown id", () => {
    expect(resolveStationKeyFromCredential(formatStationKey("ffffffffffffffff", "x".repeat(43)))).toBeNull();
  });

  it("rejects a revoked key immediately", () => {
    const { row, secret } = mintStationKey("echo");
    expect(resolveStationKeyFromCredential(secret)).not.toBeNull();
    revokeStationKey(row.id);
    expect(resolveStationKeyFromCredential(secret)).toBeNull();
  });

  it("rejects malformed strings and the shared join token", () => {
    for (const bad of ["", "   ", "not-a-key", "wtk_short_abc", "wtk_ZZZZZZZZZZZZZZZZ_abcdefghijklmnop"]) {
      expect(resolveStationKeyFromCredential(bad)).toBeNull();
    }
    // The join token is a plain hex string. It must not parse as a key, or "join token OR
    // station key" would be ambiguous at dispatch.
    expect(resolveStationKeyFromCredential("a".repeat(64))).toBeNull();
    expect(resolveStationKeyFromCredential(null)).toBeNull();
    expect(resolveStationKeyFromCredential(undefined)).toBeNull();
  });
});

describe("rotation", () => {
  it("minting for a callsign that already has an active key revokes the predecessor", () => {
    const first = mintStationKey("foxtrot");
    const second = mintStationKey("foxtrot");
    expect(second.revokedPredecessorId).toBe(first.row.id);
    expect(resolveStationKeyFromCredential(first.secret)).toBeNull();
    expect(resolveStationKeyFromCredential(second.secret)?.id).toBe(second.row.id);
    // Exactly one live credential for the callsign, enforced by the partial unique index.
    expect(dbListStationKeys().filter((k) => k.callsign === "foxtrot" && k.revoked_at === null)).toHaveLength(1);
  });
});

describe("enrollment codes", () => {
  it("stores only the hash of a code, never the code", () => {
    const { code } = createEnrollment("golf");
    // The row is keyed by sha256(code), so looking it up BY THE CODE finds nothing. A read of
    // this table therefore yields no code anyone could redeem — it can only verify one already
    // presented.
    expect(dbGetEnrollment(code)).toBeUndefined();
    expect(code.length).toBeGreaterThanOrEqual(22);
    // …and the code does still redeem, so the miss above is about storage, not a broken write.
    expect(redeemEnrollment(code)?.callsign).toBe("golf");
  });

  it("redeems exactly once", () => {
    const { code } = createEnrollment("hotel");
    const first = redeemEnrollment(code);
    expect(first).not.toBeNull();
    expect(first?.callsign).toBe("hotel");
    expect(resolveStationKeyFromCredential(first!.key)?.callsign).toBe("hotel");

    const second = redeemEnrollment(code);
    expect(second).toBeNull();
    // and the second attempt minted nothing
    expect(dbListStationKeys().filter((k) => k.callsign === "hotel")).toHaveLength(1);
  });

  it("refuses an expired code", () => {
    const { code } = createEnrollment("india", "agent", null, -1_000);
    expect(redeemEnrollment(code)).toBeNull();
    expect(dbGetActiveStationKeyByCallsign("india")).toBeUndefined();
  });

  it("carries the role through to the minted key", () => {
    const { code } = createEnrollment("juliet", "bridge");
    const redeemed = redeemEnrollment(code);
    expect(redeemed?.role).toBe("bridge");
    expect(resolveStationKeyFromCredential(redeemed!.key)?.role).toBe("bridge");
  });

  it("redeeming for a callsign with an active key rotates it, leaving exactly one live row", () => {
    const original = mintStationKey("kilo");
    const { code } = createEnrollment("kilo");
    const redeemed = redeemEnrollment(code);
    expect(redeemed?.revokedPredecessorId).toBe(original.row.id);
    expect(resolveStationKeyFromCredential(original.secret)).toBeNull();
    expect(dbListStationKeys().filter((k) => k.callsign === "kilo" && k.revoked_at === null)).toHaveLength(1);
  });

  it("sweeps long-expired unredeemed codes, but never redeemed ones", () => {
    // The table is otherwise INSERT-only, so without a sweep a long-running hub accumulates a row
    // for every code an operator ever minted and nobody used.
    const day = 24 * 60 * 60_000;
    const stale = createEnrollment("stale", "agent", null, -2 * day);
    const kept = createEnrollment("kept");
    redeemEnrollment(kept.code);

    // Minting anything triggers the sweep.
    createEnrollment("trigger");

    expect(dbFindEnrollmentByCode(stale.code)).toBeUndefined();
    // The redeemed row survives: it is the audit trail tying a key back to its enrollment.
    expect(dbFindEnrollmentByCode(kept.code)?.key_id).toBeTruthy();
  });

  it("refuses a garbage code without minting", () => {
    const before = dbListStationKeys().length;
    expect(redeemEnrollment("not-a-real-code")).toBeNull();
    expect(redeemEnrollment("")).toBeNull();
    expect(dbListStationKeys()).toHaveLength(before);
  });
});
