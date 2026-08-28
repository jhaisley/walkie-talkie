import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  dbCreateEnrollment,
  dbCreateStationKey,
  dbGetStationKeyById,
  dbRedeemEnrollment,
  dbRevokeStationKey,
} from "./db.js";
import type { StationKeyRow, UserRole } from "./types.js";

/**
 * Per-station credentials.
 *
 * The problem this exists to solve: /register was gated by ONE shared join token, so any holder
 * could claim any free callsign — and the installer served that token, unauthenticated, to
 * anyone who could reach its port. A station key binds a credential to exactly one callsign,
 * which turns "who are you?" from a self-declaration into something the hub can check.
 *
 * The module is deliberately thin over db.ts and takes only an IncomingMessage, so every rule
 * here is unit-testable without standing up a server — the way polling.ts isolates
 * resolvePollTimeoutMs.
 */

/**
 * `wtk_<id>_<secret>`.
 *
 * The `id` half is a public lookup handle: the hub reads ONE indexed row instead of hashing the
 * presented secret against every key it has ever issued. The `wtk_` prefix is there so a secret
 * scanner can recognise a leaked credential on sight — this repo already runs detect-secrets
 * and gitleaks, and a bare base64 blob is invisible to both.
 */
const KEY_PREFIX = "wtk_";
/** 8 bytes -> 16 hex chars. Fixed width is what makes the format parseable positionally. */
const ID_BYTES = 8;
/** 32 bytes -> 43 base64url chars. */
const SECRET_BYTES = 32;
/** 16 bytes -> 22 base64url chars, i.e. 128 bits. */
const CODE_BYTES = 16;

/**
 * Default enrollment-code lifetime: long enough to walk to the other machine, short enough that
 * a code left on a screen or in a chat log is worthless by the time anyone else reads it.
 */
export const DEFAULT_ENROLLMENT_TTL_MS = 30 * 60_000;

/**
 * The secret half is 256 bits of CSPRNG output, not a password: there is no dictionary to slow
 * down, so a KDF here would buy nothing and put ~100ms on every /register. sha256 plus a
 * constant-time compare is the correct shape for a high-entropy bearer secret.
 */
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time equality over two hex digests. Length-guarded: timingSafeEqual throws on unequal lengths. */
function hashEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface MintedStationKey {
  row: StationKeyRow;
  /** The plaintext credential. Returned EXACTLY once and never persisted in recoverable form. */
  secret: string;
  /** The key this one displaced, if the callsign already had an active key. */
  revokedPredecessorId: string | null;
}

export function formatStationKey(id: string, secret: string): string {
  return `${KEY_PREFIX + id}_${secret}`;
}

/**
 * Mint a key for `callsign`, revoking whatever active key it had. Rotation is not an option the
 * caller chooses — it is the only behaviour, which is what makes an old install command in
 * someone's scrollback dead rather than a second identity for the same station.
 */
export function mintStationKey(
  callsign: string,
  role: UserRole = "agent",
  label: string | null = null,
  createdBy = "operator",
): MintedStationKey {
  const id = randomBytes(ID_BYTES).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const row: StationKeyRow = {
    id,
    callsign,
    secret_hash: sha256(secret),
    role,
    label,
    created_at: Date.now(),
    created_by: createdBy,
    last_used_at: null,
    revoked_at: null,
  };
  const { revokedPredecessorId } = dbCreateStationKey(row);
  return { row, secret: formatStationKey(id, secret), revokedPredecessorId };
}

/**
 * Split a presented credential into its halves.
 *
 * Note the id is matched as fixed-width hex rather than by splitting on "_": base64url includes
 * "_", so a naive split would truncate roughly half of all secrets and reject valid keys
 * non-deterministically.
 *
 * Returns null for anything that is not this format — including the shared join token, which is
 * how "join token OR station key" stays unambiguous at the dispatch layer.
 */
export function parseStationKey(raw: string | undefined | null): { id: string; secret: string } | null {
  if (typeof raw !== "string") return null;
  const m = /^wtk_([0-9a-f]{16})_([A-Za-z0-9_-]{16,})$/.exec(raw.trim());
  if (!m) return null;
  return { id: m[1], secret: m[2] };
}

/** Extract a Bearer credential from a request, without judging what kind it is. */
function bearer(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

/**
 * Resolve a request's Authorization header to a LIVE station key, or null.
 *
 * Null covers every failure identically — malformed, unknown id, wrong secret, revoked, or the
 * shared join token — because the caller's next move is the same in all of them, and
 * distinguishing them in the return value would only invite a caller to leak which one it was.
 */
export function resolveStationKey(req: IncomingMessage): StationKeyRow | null {
  return resolveStationKeyFromCredential(bearer(req));
}

/** The header-free half of resolveStationKey, so tests and non-HTTP callers can verify a raw string. */
export function resolveStationKeyFromCredential(raw: string | null | undefined): StationKeyRow | null {
  const parsed = parseStationKey(raw);
  if (!parsed) return null;
  const row = dbGetStationKeyById(parsed.id);
  if (!row) return null;
  // A revoked key is dead the instant it is revoked — no grace, no "until the next restart".
  if (row.revoked_at !== null) return null;
  if (!hashEquals(row.secret_hash, sha256(parsed.secret))) return null;
  return row;
}

export function revokeStationKey(id: string): StationKeyRow | null {
  return dbRevokeStationKey(id);
}

export interface CreatedEnrollment {
  code: string;
  callsign: string;
  role: UserRole;
  expiresAt: number;
}

/**
 * Issue a one-time enrollment code for `callsign`.
 *
 * The code, not the key, is what an operator handles: it is 128 bits, single-use, and expiring.
 * Only sha256(code) is stored — the hub cannot re-display a code it issued, and neither can
 * anyone who reads the database.
 */
export function createEnrollment(
  callsign: string,
  role: UserRole = "agent",
  label: string | null = null,
  ttlMs: number = DEFAULT_ENROLLMENT_TTL_MS,
): CreatedEnrollment {
  const code = randomBytes(CODE_BYTES).toString("base64url");
  const now = Date.now();
  const expiresAt = now + ttlMs;
  dbCreateEnrollment({
    code_hash: sha256(code),
    callsign,
    role,
    label,
    created_at: now,
    expires_at: expiresAt,
    redeemed_at: null,
    key_id: null,
  });
  return { code, callsign, role, expiresAt };
}

export interface RedeemedEnrollment {
  keyId: string;
  /** The plaintext credential — the only time it exists outside the station that asked for it. */
  key: string;
  callsign: string;
  role: UserRole;
  revokedPredecessorId: string | null;
}

/**
 * Redeem a code, minting the key it stands for.
 *
 * The key material is generated BEFORE the claim so the claim can be a single conditional
 * UPDATE that also records key_id — see dbRedeemEnrollment. If the claim loses the race (or the
 * code is unknown, spent, or expired) nothing is inserted and this returns null, so one code can
 * never mint two keys.
 */
export function redeemEnrollment(code: string, createdBy = "enroll"): RedeemedEnrollment | null {
  if (typeof code !== "string" || code.length === 0) return null;
  const keyId = randomBytes(ID_BYTES).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const result = dbRedeemEnrollment(sha256(code), keyId, sha256(secret), createdBy);
  if (!result) return null;
  return {
    keyId,
    key: formatStationKey(keyId, secret),
    callsign: result.key.callsign,
    role: result.key.role,
    revokedPredecessorId: result.revokedPredecessorId,
  };
}
