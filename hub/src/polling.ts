import type { IncomingMessage, ServerResponse } from "node:http";
import { dbGetDeliveriesAfter } from "./db.js";
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

/**
 * Ceiling for a client-requested poll window (WALKIE_TALKIE_MAX_POLL_WINDOW_MS, default 15min).
 * A client asks for its own window via ?wait=<ms> because the safe value is a property of the
 * CLIENT, not the hub: the window must sit below that client's MCP tool-call timeout, and those
 * differ per CLI (Claude Code tolerates ~30min; other clients default far lower). A single
 * hub-wide constant would have to be short enough for the shortest client in the fleet, which
 * would force every long-poll-capable station back to a 25s cycle and the idle-turn cost that
 * comes with it. Clamping here keeps a malformed or hostile value from parking a socket forever.
 */
const DEFAULT_MAX_POLL_WINDOW_MS = 900_000;
const MIN_POLL_WINDOW_MS = 1_000;

export function resolveMaxPollWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WALKIE_TALKIE_MAX_POLL_WINDOW_MS;
  if (raw === undefined || raw === "") return DEFAULT_MAX_POLL_WINDOW_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_POLL_WINDOW_MS;
  return n;
}

/**
 * The window to hold this poll open for. An absent or unusable `wait` falls back to the hub
 * default, so a client that knows nothing about this parameter behaves exactly as before.
 */
export function resolvePollWindowMs(requested: string | null, env: NodeJS.ProcessEnv = process.env): number {
  if (requested === null || requested === "") return resolvePollTimeoutMs(env);
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return resolvePollTimeoutMs(env);
  return Math.min(Math.max(n, MIN_POLL_WINDOW_MS), resolveMaxPollWindowMs(env));
}
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

/**
 * Stamp the user's last-seen now, for poll paths that don't go through addPoll (the
 * cursor=init bootstrap responds immediately without registering a pending poll, but it's
 * still a real poll that proves the listener is alive).
 */
export function recordSeen(userName: string): void {
  lastSeen.set(userName, Date.now());
}

/**
 * Seed last-seen from a PERSISTED stamp during boot-time restore. Distinct from recordSeen()
 * because nothing has happened: the station has not polled, has not proved it is alive, and may
 * never come back. Stamping Date.now() here would tell the dashboard the fleet just checked in
 * the instant the hub started, which is exactly the lie the lastSeen column exists to avoid.
 */
export function seedLastSeen(userName: string, ts: number): void {
  lastSeen.set(userName, ts);
}

/** True if the user currently has a live long-poll connection open. */
export function hasActivePoll(userName: string): boolean {
  return pendingPolls.has(userName);
}

/**
 * Register a long-poll for `userName`. When `cursor` is a number, the poll is resolved in
 * serve-by-cursor (at-least-once) mode: messages are read from the persisted delivery log
 * after that cursor and are NOT removed, so a lost/unparsed 200 recovers on the next poll
 * with the same cursor. When `cursor` is undefined, the legacy drain path (at-most-once) is
 * used unchanged, so any client that doesn't send a cursor keeps its prior behavior.
 */
export function addPoll(
  userName: string,
  req: IncomingMessage,
  res: ServerResponse,
  cursor?: number,
  windowMs: number = POLL_TIMEOUT_MS,
): void {
  removePoll(userName);
  lastSeen.set(userName, Date.now());

  console.log(`[poll-start] ${userName} waiting for messages...`);

  const timer = setTimeout(() => {
    pendingPolls.delete(userName);
    console.log(`[poll-timeout] ${userName} (no messages after ${windowMs / 1000}s)`);
    res.writeHead(204);
    res.end();
  }, windowMs);

  pendingPolls.set(userName, { userName, res, timer, cursor });

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

  // Immediate check: deliver anything already available so the client doesn't wait.
  if (cursor !== undefined) {
    const { messages, cursor: newCursor } = dbGetDeliveriesAfter(userName, cursor);
    if (messages.length > 0) {
      clearTimeout(timer);
      pendingPolls.delete(userName);
      drainQueue(userName); // discard the parallel in-memory queue; the log is authoritative
      console.log(`[poll-immediate] ${userName} <- ${messages.length} message(s) (cursor ${cursor}->${newCursor})`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ messages, cursor: newCursor }));
    }
    return;
  }

  // Legacy at-most-once: drain the in-memory queue.
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

  // Serve-by-cursor wake: re-query the delivery log after the poll's cursor.
  if (poll.cursor !== undefined) {
    const { messages, cursor: newCursor } = dbGetDeliveriesAfter(userName, poll.cursor);
    if (messages.length === 0) return;

    clearTimeout(poll.timer);
    pendingPolls.delete(userName);
    drainQueue(userName); // discard the parallel in-memory queue; the log is authoritative
    console.log(`[poll-deliver] ${userName} <- ${messages.length} message(s) (cursor ${poll.cursor}->${newCursor})`);

    poll.res.writeHead(200, { "Content-Type": "application/json" });
    poll.res.end(JSON.stringify({ messages, cursor: newCursor }));
    return;
  }

  // Legacy at-most-once wake.
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

/**
 * Drop all liveness state, as a fresh process would have it. Exists so a test can simulate a hub
 * restart in-process (the registrations now survive one, so there is finally something to test on
 * the far side); a real restart gets this for free. Mirrors resetAuthState/resetChannelState.
 */
export function resetPollingState(): void {
  closeAllPolls();
  offlineUsers.clear();
  lastSeen.clear();
}
