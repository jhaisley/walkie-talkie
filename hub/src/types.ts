import type { IncomingMessage, ServerResponse } from "node:http";

export interface MessageImage {
  data: string; // base64 (no data-URI prefix)
  mimeType: string; // e.g. "image/png"
}

export interface Message {
  id: string;
  from: string;
  to: string;
  content: string;
  channel: string;
  timestamp: number;
  image?: MessageImage;
}

export type UserRole = "agent" | "bridge";

export interface User {
  name: string;
  token: string;
  role: UserRole;
  registeredAt: number;
  /**
   * The station key (`station_keys.id`) this registration was proven with, if any. Absent for
   * a registration made with the shared join token, and for the dashboard's lazily-created
   * "operator". It is what makes a re-register self-provable without an oldToken, and what lets
   * revocation know whether the live session belongs to the key being revoked.
   */
  keyId?: string;
}

/**
 * A per-station credential. The plaintext secret is NEVER stored — only `secret_hash`
 * (sha256 hex). One ACTIVE key per callsign is enforced structurally by a partial unique
 * index, so minting for a callsign that already has one is a rotation, not a second identity.
 */
export interface StationKeyRow {
  id: string;
  callsign: string;
  secret_hash: string;
  role: UserRole;
  label: string | null;
  created_at: number;
  created_by: string;
  last_used_at: number | null;
  /** NULL = active. Set = dead: resolveStationKey refuses it from that moment on. */
  revoked_at: number | null;
}

/**
 * A one-time enrollment code, keyed by the sha256 of the code — the code itself is never
 * stored, so a database read cannot enroll anything. Redemption is a single conditional
 * UPDATE, which is what stops one code minting two keys.
 */
export interface StationEnrollmentRow {
  code_hash: string;
  callsign: string;
  role: UserRole;
  label: string | null;
  created_at: number;
  expires_at: number;
  redeemed_at: number | null;
  key_id: string | null;
}

export interface RegisterRequest {
  name: string;
  oldToken?: string;
  role?: UserRole;
}

export interface RegisterResponse {
  token: string;
  name: string;
}

export interface SendRequest {
  to: string;
  content: string;
  channel?: string;
  image?: MessageImage;
}

export interface Channel {
  name: string;
  createdBy: string;
  createdAt: number;
}

export interface SendResponse {
  id: string;
  to: string;
}

export interface PollResponse {
  messages: Message[];
}

export interface UsersResponse {
  users: Array<{
    name: string;
    online: boolean;
    role: string;
    /** Epoch ms of the user's most recent poll; null if they have never polled. */
    lastSeen: number | null;
    /** Whether the user has an open long-poll right now — the reliable liveness signal. */
    hasActivePoll: boolean;
  }>;
}

export interface ErrorResponse {
  error: string;
}

export type PendingPoll = {
  userName: string;
  res: ServerResponse;
  timer: ReturnType<typeof setTimeout>;
  /**
   * Delivery cursor for serve-by-cursor (at-least-once) polls. When set, the poll is
   * resolved from the persisted delivery log (deliveries after this id), NOT by draining
   * the in-memory queue. Undefined = a legacy drain poll (at-most-once, backward compat).
   */
  cursor?: number;
};

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, userName?: string) => Promise<void>;
