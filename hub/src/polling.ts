import type { IncomingMessage, ServerResponse } from "node:http";
import { dbGetDeliveriesAfter } from "./db.js";
import { drainQueue } from "./router.js";
import type { Message, PendingPoll, PollSink } from "./types.js";

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
 *
 * NONE OF THIS APPLIES to a station whose radio is hosted by the hub (POST /mcp). There is no
 * client->hub long-poll socket there at all: radio_standby resolves in-process via awaitPoll(),
 * so no client-side abort can reach req.on("close") and the three-term ordering collapses to
 * two — the wait window only has to stay under the station's MCP tool-call timeout.
 *
 * That path has its OWN ordering invariant, in the same family and with the same failure mode:
 *
 *     WALKIE_TALKIE_MCP_SESSION_IDLE_MS  >  the longest standby window a station may request
 *
 * The idle sweeper in hub/src/mcp.ts closes MCP sessions that have gone quiet, and closing a
 * session marks its station offline and arms the stale grace. During a legitimate 20-minute
 * standby a session has exactly ONE in-flight request and ZERO new activity, so a sweeper that
 * looked only at "time since last request" would reap precisely the stations behaving best.
 * The in-flight counter is the real guard; the idle window is the belt to its braces. If you
 * raise resolveMaxPollWindowMs below, raise the MCP idle window with it.
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

/** A sink that writes the poll result to an HTTP response — the original, only behaviour. */
function httpSink(res: ServerResponse): PollSink {
  return {
    deliver(messages, cursor) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(cursor === undefined ? { messages } : { messages, cursor }));
    },
    empty() {
      res.writeHead(204);
      res.end();
    },
    ended: () => res.writableEnded,
  };
}

/**
 * Shared body of addPoll and awaitPoll: register the pending poll, arm its window, and serve
 * anything already waiting so the caller doesn't sit through a window for a message that has
 * already arrived.
 *
 * Returns true if the poll was settled immediately (nothing is left in pendingPolls).
 */
function startPoll(userName: string, sink: PollSink, cursor: number | undefined, windowMs: number): boolean {
  removePoll(userName);
  lastSeen.set(userName, Date.now());

  console.log(`[poll-start] ${userName} waiting for messages...`);

  const timer = setTimeout(() => {
    pendingPolls.delete(userName);
    console.log(`[poll-timeout] ${userName} (no messages after ${windowMs / 1000}s)`);
    sink.empty();
  }, windowMs);

  pendingPolls.set(userName, { userName, sink, timer, cursor });

  // Immediate check: deliver anything already available so the client doesn't wait.
  if (cursor !== undefined) {
    const { messages, cursor: newCursor } = dbGetDeliveriesAfter(userName, cursor);
    if (messages.length > 0) {
      clearTimeout(timer);
      pendingPolls.delete(userName);
      drainQueue(userName); // discard the parallel in-memory queue; the log is authoritative
      console.log(`[poll-immediate] ${userName} <- ${messages.length} message(s) (cursor ${cursor}->${newCursor})`);
      sink.deliver(messages, newCursor);
      return true;
    }
    return false;
  }

  // Legacy at-most-once: drain the in-memory queue.
  const messages = drainQueue(userName);
  if (messages.length > 0) {
    clearTimeout(timer);
    pendingPolls.delete(userName);
    console.log(`[poll-immediate] ${userName} <- ${messages.length} queued message(s)`);
    sink.deliver(messages);
    return true;
  }
  return false;
}

/**
 * Register a long-poll for `userName`. When `cursor` is a number, the poll is resolved in
 * serve-by-cursor (at-least-once) mode: messages are read from the persisted delivery log
 * after that cursor and are NOT removed, so a lost/unparsed 200 recovers on the next poll
 * with the same cursor. When `cursor` is undefined, the legacy drain path (at-most-once) is
 * used unchanged, so any client that doesn't send a cursor keeps its prior behavior.
 *
 * Signature and observable behaviour are deliberately unchanged by the sink refactor: this is
 * the delivery path every currently-deployed station uses, and poll-timeout / poll-window /
 * poll-cursor / stale-grace are the guard that it stayed that way.
 */
export function addPoll(
  userName: string,
  req: IncomingMessage,
  res: ServerResponse,
  cursor?: number,
  windowMs: number = POLL_TIMEOUT_MS,
): void {
  const sink = httpSink(res);
  // Detect unexpected connection drop (agent crash, network loss).
  // Listen on req (not res) — more reliable when no response has been written yet.
  //
  // This is the ONLY path that fires onDisconnectCallback. awaitPoll's cancellation path
  // deliberately does not: a cancelled MCP tool call is a station changing its mind, and the
  // HTTP path's inability to tell that apart from a crash is what reaped the fleet once.
  req.on("close", () => {
    const poll = pendingPolls.get(userName);
    // Sink identity, not just presence: a close arriving after this poll was already replaced
    // by a newer one for the same callsign must not tear the NEWER one down.
    if (!res.writableEnded && poll?.sink === sink) {
      console.log(`[poll-disconnect] ${userName} connection dropped`);
      clearTimeout(poll.timer);
      pendingPolls.delete(userName);
      onDisconnectCallback?.(userName);
    }
  });

  startPoll(userName, sink, cursor, windowMs);
}

/**
 * The in-process twin of addPoll, for a station whose radio is hosted by the hub.
 *
 * Resolves with the messages when any are routed, or null when the window elapses or the tool
 * call is cancelled. Registering in the SAME pendingPolls map is the point: deliverMessage(),
 * hasActivePoll(), removePoll() and closeAllPolls() then treat a remote station exactly like
 * an HTTP one, so /users liveness, kick and shutdown all keep working with no special case.
 *
 * Cancellation (`signal`) removes the poll and resolves null. It must NEVER reach
 * onDisconnectCallback — see addPoll above.
 */
export function awaitPoll(
  userName: string,
  cursor: number | undefined,
  windowMs: number,
  signal?: AbortSignal,
): Promise<{ messages: Message[]; cursor?: number } | null> {
  return new Promise((resolve) => {
    let settled = false;
    let abortListener: (() => void) | undefined;

    const settle = (value: { messages: Message[]; cursor?: number } | null): void => {
      if (settled) return;
      settled = true;
      if (abortListener) signal?.removeEventListener("abort", abortListener);
      resolve(value);
    };

    const sink: PollSink = {
      deliver: (messages, newCursor) => settle({ messages, cursor: newCursor }),
      empty: () => settle(null),
      ended: () => settled,
    };

    if (signal?.aborted) {
      settle(null);
      return;
    }

    abortListener = () => {
      if (settled) return;
      console.log(`[poll-cancel] ${userName} standby cancelled by the station`);
      // Only tear down if the map still holds OUR poll: a station that started a fresh standby
      // under the same callsign has already replaced it, and killing that would be a bug.
      // removePoll ends the sink (resolving null) and clears the timer. No offline marking and
      // no stale grace — this is not a station that died.
      if (pendingPolls.get(userName)?.sink === sink) removePoll(userName);
      settle(null);
    };
    signal?.addEventListener("abort", abortListener, { once: true });

    startPoll(userName, sink, cursor, windowMs);
  });
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

    poll.sink.deliver(messages, newCursor);
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

  poll.sink.deliver(messages);
}

export function closeAllPolls(): void {
  for (const [, poll] of pendingPolls) {
    clearTimeout(poll.timer);
    if (!poll.sink.ended()) poll.sink.empty();
  }
  pendingPolls.clear();
}

export function removePoll(userName: string): void {
  const poll = pendingPolls.get(userName);
  if (poll) {
    clearTimeout(poll.timer);
    pendingPolls.delete(userName);
    if (!poll.sink.ended()) poll.sink.empty();
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
