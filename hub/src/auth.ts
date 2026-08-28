import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { removeUserFromAllChannels } from "./channels.js";
import {
  dbDeleteRegistration,
  dbListRegistrations,
  dbPruneRegistrations,
  dbTouchRegistrationSeen,
  dbUpsertRegistration,
  type RegistrationRow,
} from "./db.js";
import type { User, UserRole } from "./types.js";

// The request-path lookup. authenticateRequest runs on every protected request, so these stay
// Maps rather than becoming a query — they are a write-through CACHE that is authoritative
// in-process, not a read path into SQLite. Every mutation below updates both the Map and the row.
const users = new Map<string, User>();
const tokenToName = new Map<string, string>();

/**
 * Names restored from the DB at boot that no client has authenticated as since.
 *
 * A restored registration is a HINT, not a lock. The stale reaper is armed only by a poll
 * disconnect (server.ts onPollDisconnect), and a restored entry has never had a poll, so no
 * grace timer exists for it. Meanwhile a station that lost its client-side token (token-store
 * file wiped, machine reimaged, or clearStoredToken after a 401) re-registers with no oldToken.
 * Without this set that station would get a permanent 409 on its own callsign and loop forever —
 * whereas today the restart frees the name and it self-heals. So an unclaimed entry may be taken
 * over without proving the old token; the window closes at the real station's first authenticated
 * request (markClaimed at the protectedRoutes chokepoint).
 *
 * This concedes nothing that was not already conceded: /register is gated only by the SHARED join
 * token, so any holder can already claim any free callsign. Today the post-restart free-for-all
 * window is UNBOUNDED; this bounds it to "until the real station checks in".
 */
const unclaimed = new Set<string>();

/**
 * Last last_seen_at value actually written per name, so touchSeen — which sits on every
 * authenticated request — does not turn into a write per request.
 */
const lastPersistedSeen = new Map<string, number>();
const SEEN_PERSIST_INTERVAL_MS = 30_000;

const DEFAULT_REGISTRATION_TTL_MS = 604_800_000; // 7 days

/**
 * How long an unseen registration survives before the boot-time hydrate drops it.
 *
 * This is the whole of roster hygiene: pruning happens once, at hydrate, rather than on a timer,
 * so there is no scheduling to reason about and the outcome is deterministic. A station unseen
 * for longer than this simply is not restored, and its callsign is free again.
 *
 * A value <= 0 DISABLES pruning. Ghost registrations then accumulate forever: they show up in
 * /users, get the shutdown notice enqueued at every restart, and inflate the bridge's
 * CONNECTED_USERS list. They stay reclaimable (they are unclaimed), so this is untidy rather than
 * dangerous, but there is no reason to set it. Invalid/absent falls back to the default.
 */
export function resolveRegistrationTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WALKIE_TALKIE_REGISTRATION_TTL_MS;
  if (raw === undefined || raw === "") return DEFAULT_REGISTRATION_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_REGISTRATION_TTL_MS;
}

export function getUserToken(name: string): string | null {
  return users.get(name)?.token ?? null;
}

export function registerUser(name: string, role: UserRole = "agent", keyId?: string): User {
  if (users.has(name)) {
    throw new Error(`User "${name}" is already registered`);
  }
  const token = randomBytes(32).toString("hex");
  const user: User = { name, token, role, registeredAt: Date.now() };
  // Recorded only when the registration was proven with a station key. It is what lets a
  // re-register prove ownership without a persisted oldToken, and what lets key revocation tell
  // whether the LIVE session belongs to the key being revoked.
  if (keyId) user.keyId = keyId;
  users.set(name, user);
  tokenToName.set(token, name);
  // A fresh registration is by definition held by whoever just made it.
  unclaimed.delete(name);
  lastPersistedSeen.delete(name);
  dbUpsertRegistration(name, token, role, user.registeredAt);
  return user;
}

/** The live registration for `name`, or null. Read-only: callers must not mutate the returned object. */
export function getUser(name: string): User | null {
  return users.get(name) ?? null;
}

/**
 * The live registration that was proven with `keyId`, or null.
 *
 * Revocation needs this: the session token minted at /register never re-consults the key, so a
 * revoked station keeps sending and polling until the stale reaper gets it — which is 30s by
 * default and NEVER when WALKIE_TALKIE_STALE_GRACE_MS <= 0, precisely the setting a sleep-prone
 * host is told to use. Finding the session lets the revoke handler end it immediately.
 */
export function findUserByKeyId(keyId: string): User | null {
  for (const user of users.values()) {
    if (user.keyId === keyId) return user;
  }
  return null;
}

export function unregisterUser(name: string): void {
  const user = users.get(name);
  if (user) {
    tokenToName.delete(user.token);
    users.delete(name);
    unclaimed.delete(name);
    lastPersistedSeen.delete(name);
    // Deliberately asymmetric: the in-memory channel sets are cleared but the channel_members
    // ROWS are left alone, so a returning station gets its channels back via dbGetUserChannels.
    // Deleting them here would make an unregister silently destroy channel membership.
    removeUserFromAllChannels(name);
    dbDeleteRegistration(name);
  }
}

/**
 * The callsign a session token currently belongs to, or null.
 *
 * Exported because a hub-hosted MCP session calls hub operations in-process rather than over
 * HTTP, so there is no request to authenticate — but the token still has to be checked on every
 * call. Skipping that would make an MCP session's held token unrevocable: a kicked or
 * stale-reaped station would keep acting under its callsign because nothing ever re-examined
 * the credential it was carrying in memory.
 */
export function getUserByToken(token: string): string | null {
  return tokenToName.get(token) ?? null;
}

export function authenticateRequest(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  return getUserByToken(auth.slice(7));
}

export function getRegisteredUsers(): string[] {
  return Array.from(users.keys());
}

export function getUserRole(name: string): UserRole | null {
  return users.get(name)?.role ?? null;
}

export function getUsersByRole(role: UserRole): string[] {
  return Array.from(users.values())
    .filter((u) => u.role === role)
    .map((u) => u.name);
}

export function isUserRegistered(name: string): boolean {
  return users.has(name);
}

/** True if `name` was restored from the DB at boot and nobody has authenticated as it since. */
export function isUnclaimed(name: string): boolean {
  return unclaimed.has(name);
}

/** Close the takeover window for `name`: someone has proved they hold its token. */
export function markClaimed(name: string): void {
  unclaimed.delete(name);
}

/**
 * Record that `name` was seen now, debounced. Called on every authenticated request, so the
 * debounce is what keeps it from becoming an UPDATE per request; only one write per station per
 * SEEN_PERSIST_INTERVAL_MS reaches SQLite.
 */
export function touchSeen(name: string): void {
  const now = Date.now();
  const last = lastPersistedSeen.get(name);
  if (last !== undefined && now - last < SEEN_PERSIST_INTERVAL_MS) return;
  lastPersistedSeen.set(name, now);
  dbTouchRegistrationSeen(name, now);
}

/**
 * Hydrate the roster from the DB: prune by TTL, then repopulate the caches from what survives and
 * mark every restored name unclaimed.
 *
 * Returns the surviving rows so the caller (restore.ts) can finish the job — restoring the roster
 * WITHOUT also restoring channel membership is strictly worse than not restoring at all, because
 * every station would then be authenticated and unable to send anything.
 */
export function loadPersistedRegistrations(ttlMs: number = resolveRegistrationTtlMs()): RegistrationRow[] {
  if (ttlMs > 0) {
    const pruned = dbPruneRegistrations(Date.now() - ttlMs);
    if (pruned.length > 0) {
      console.log(`[restore] pruned ${pruned.length} stale registration(s): ${pruned.join(", ")}`);
    }
  }
  const rows = dbListRegistrations();
  for (const row of rows) {
    const role: UserRole = row.role === "bridge" ? "bridge" : "agent";
    const user: User = { name: row.name, token: row.token, role, registeredAt: row.registered_at };
    users.set(row.name, user);
    tokenToName.set(row.token, row.name);
    unclaimed.add(row.name);
    if (row.last_seen_at !== null) lastPersistedSeen.set(row.name, row.last_seen_at);
  }
  return rows;
}

/**
 * Memory only, deliberately. The test harness calls this BEFORE initDB(), so anything touching
 * the DB here would throw on the first test file. Persistence is cleared by unregisterUser and by
 * the TTL prune, never by a state reset.
 */
export function resetAuthState(): void {
  users.clear();
  tokenToName.clear();
  unclaimed.clear();
  lastPersistedSeen.clear();
}
