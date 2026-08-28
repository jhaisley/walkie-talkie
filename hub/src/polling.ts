import type { IncomingMessage, ServerResponse } from "node:http";
import { drainQueue } from "./router.js";
import type { PendingPoll } from "./types.js";

const DEFAULT_POLL_TIMEOUT_MS = 25_000; // 25 seconds

/**
 * How long the hub holds an empty /poll open before answering 204.
 *
 * ORDERING CONSTRAINT: this MUST stay strictly below the MCP client's poll
 * timeout (mcp-server/src/client.ts, `timeoutMs = 30_000`). The hub has to be
 * the one that ends an idle poll, not the client.
 *
 * If the client aborts first, its abort closes the socket while the poll is
 * still pending. That fires req.on("close") in addPoll(), which takes the
 * disconnect branch (res not ended, poll still in pendingPolls) and calls
 * onPollDisconnect -> the hub marks the station offline and arms the
 * STALE_GRACE_MS auto-unregister timer. Every idle standby then looked like a
 * crashed agent: with the old 1 hour default, all stations cycled
 * "[offline] <name> (grace period 30s)" and got auto-unregistered mid-work.
 *
 * When the hub answers first, the timeout path deletes the entry from
 * pendingPolls and ends the response, so the subsequent close is a no-op --
 * the guard `!res.writableEnded && pendingPolls.has(userName)` is false on both
 * counts. No disconnect callback, no grace timer.
 *
 * Configurable via WALKIE_TALKIE_POLL_TIMEOUT_MS (milliseconds). Raise it only
 * alongside the MCP client timeout, and keep the gap wide enough to cover
 * request latency. Non-numeric or non-positive values fall back to the default.
 */
export function resolvePollTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WALKIE_TALKIE_POLL_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_POLL_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_POLL_TIMEOUT_MS;
  return n;
}

const POLL_TIMEOUT_MS = resolvePollTimeoutMs();
const pendingPolls = new Map<string, PendingPoll>();

// Track users explicitly detected as offline (poll connection dropped).
// Registered users NOT in this set are considered online (default = online).
const offlineUsers = new Set<string>();

// Per-subscriber last-seen: epoch ms of the user's most recent poll. Lets a
// silently-dead subscriber (listener wedged/killed → no recent poll) be detected
// via /users, instead of looking identical to an idle-but-healthy channel.
const lastSeen = new Map<string, number>();

let onDisconnectCallback: ((userName: string) => void) | null = null;

export function onPollDisconnect(cb: (userName: string) => void): void {
  onDisconnectCallback = cb;
}

export function isOnline(userName: string): boolean {
  return !offlineUsers.has(userName);
}

export function setOnline(userName: string): void {
  offlineUsers.delete(userName);
}

export function setOffline(userName: string): void {
  offlineUsers.add(userName);
}

/** Epoch ms of the user's most recent poll, or null if they have never polled. */
export function getLastSeen(userName: string): number | null {
  return lastSeen.get(userName) ?? null;
}

/** True if the user currently has a live long-poll connection open. */
export function hasActivePoll(userName: string): boolean {
  return pendingPolls.has(userName);
}

export function addPoll(userName: string, req: IncomingMessage, res: ServerResponse): void {
  removePoll(userName);
  lastSeen.set(userName, Date.now());

  console.log(`[poll-start] ${userName} waiting for messages...`);

  const timer = setTimeout(() => {
    pendingPolls.delete(userName);
    console.log(`[poll-timeout] ${userName} (no messages after ${POLL_TIMEOUT_MS / 1000}s)`);
    res.writeHead(204);
    res.end();
  }, POLL_TIMEOUT_MS);

  pendingPolls.set(userName, { userName, res, timer });

  // Detect unexpected connection drop (agent crash, network loss).
  // Listen on req (not res) — more reliable when no response has been written yet.
  req.on("close", () => {
    if (!res.writableEnded && pendingPolls.has(userName)) {
      console.log(`[poll-disconnect] ${userName} connection dropped`);
      clearTimeout(timer);
      pendingPolls.delete(userName);
      onDisconnectCallback?.(userName);
    }
  });

  // Check if there are already queued messages
  const messages = drainQueue(userName);
  if (messages.length > 0) {
    clearTimeout(timer);
    pendingPolls.delete(userName);
    console.log(`[poll-immediate] ${userName} <- ${messages.length} queued message(s)`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messages }));
  }
}

export function deliverMessage(userName: string): void {
  const poll = pendingPolls.get(userName);
  if (!poll) return;

  const messages = drainQueue(userName);
  if (messages.length === 0) return;

  clearTimeout(poll.timer);
  pendingPolls.delete(userName);

  for (const m of messages) {
    if (m.image) {
      console.log(`[poll-deliver] ${userName} <- image (${m.image.mimeType}, ${m.image.data.length} chars base64)`);
    }
  }
  console.log(`[poll-deliver] ${userName} <- ${messages.length} message(s)`);

  poll.res.writeHead(200, { "Content-Type": "application/json" });
  poll.res.end(JSON.stringify({ messages }));
}

export function closeAllPolls(): void {
  for (const [, poll] of pendingPolls) {
    clearTimeout(poll.timer);
    if (!poll.res.writableEnded) {
      poll.res.writeHead(204);
      poll.res.end();
    }
  }
  pendingPolls.clear();
}

export function removePoll(userName: string): void {
  const poll = pendingPolls.get(userName);
  if (poll) {
    clearTimeout(poll.timer);
    pendingPolls.delete(userName);
    if (!poll.res.writableEnded) {
      poll.res.writeHead(204);
      poll.res.end();
    }
  }
}
