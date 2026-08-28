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

/**
 * Where a resolved long-poll's result goes.
 *
 * Introduced so an in-process waiter (a hub-hosted MCP session's radio_standby) can live in the
 * SAME pendingPolls map as an HTTP long-poll. That shared map is load-bearing: hasActivePoll()
 * feeds GET /users and the dashboard's liveness column, and removePoll() is what kick,
 * unregister and re-register use to end a poll. A parallel registry for remote stations would
 * have shown every one of them as "not listening" on the dashboard and left them unkickable.
 *
 * `ended()` replaces the old `res.writableEnded` guard: a promise sink is "ended" once settled.
 */
export type PollSink = {
  /** Hand the poll its result. Called at most once. */
  deliver(messages: Message[], cursor?: number): void;
  /** End the poll with no messages — the 204 equivalent (timeout, kick, shutdown, cancel). */
  empty(): void;
  /** True once this sink has been settled and must not be written to again. */
  ended(): boolean;
};

export type PendingPoll = {
  userName: string;
  sink: PollSink;
  timer: ReturnType<typeof setTimeout>;
  /**
   * Delivery cursor for serve-by-cursor (at-least-once) polls. When set, the poll is
   * resolved from the persisted delivery log (deliveries after this id), NOT by draining
   * the in-memory queue. Undefined = a legacy drain poll (at-most-once, backward compat).
   */
  cursor?: number;
};

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, userName?: string) => Promise<void>;
