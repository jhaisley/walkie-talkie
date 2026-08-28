import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { removeUserFromAllChannels } from "./channels.js";
import type { User, UserRole } from "./types.js";

const users = new Map<string, User>();
const tokenToName = new Map<string, string>();

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
    removeUserFromAllChannels(name);
  }
}

export function authenticateRequest(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  return tokenToName.get(token) ?? null;
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

export function resetAuthState(): void {
  users.clear();
  tokenToName.clear();
}
