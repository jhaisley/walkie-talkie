import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RadioDeps, RadioHubClient, RadioMessage } from "@walkie-talkie/mcp-server/radio-deps.js";
import { nullTokenStore } from "@walkie-talkie/mcp-server/radio-deps.js";
import { registerRadioTools } from "@walkie-talkie/mcp-server/tools.js";
import { getRegisteredUsers, getUserByToken, getUserRole, isUserRegistered, unregisterUser } from "./auth.js";
import {
  ensureChannelMembership,
  getChannelMemberCounts,
  joinChannel,
  leaveChannel,
  normalizeChannel,
} from "./channels.js";
import { dbCreateChannel, dbGetChannel, dbGetDeliveriesAfter, dbGetDeliveryHighWater, dbListChannels } from "./db.js";
import { broadcast } from "./events.js";
import { resolveRemoteFetch } from "./fetch-guard.js";
import {
  awaitPoll,
  isOnline,
  recordSeen,
  removePoll,
  resolveMaxPollWindowMs,
  resolvePollTimeoutMs,
  setOnline,
} from "./polling.js";
import { drainQueue, notifyBridges, removeQueue, routeMessage } from "./router.js";
import type { Message, MessageImage, UserRole } from "./types.js";
import { getBuildInfo } from "./version.js";

/**
 * Hub-hosted MCP over Streamable HTTP.
 *
 * A station used to run its own copy of the MCP server as a child process, installed from a
 * tarball. That is where most of the fleet's operational pain came from: version skew across
 * stations, a reinstall-then-restart ordering nobody could remember, and agents reasoning about
 * behaviour their own bundle predated. Serving the same tools from the hub deletes the class:
 * there is exactly one build, and it is the one running.
 *
 * The awkward part is that one process now serves every station, so everything the stdio server
 * kept in module state has to become per-session state, and everything it did on the station's
 * machine (read a file, fetch a URL) has to stop happening on the hub's. That is what RadioDeps
 * is for; see mcp-server/src/radio-deps.ts.
 */

export interface McpHubOps {
  registerStation(
    name: string,
    role?: UserRole,
    oldToken?: string,
  ): { ok: true; token: string; name: string; reclaimed: boolean } | { ok: false; status: number; error: string };
  sendStationMessage(from: string, to: string, content: string, channel?: string, image?: MessageImage): Message;
  markStationOffline(userName: string): void;
  joinToken: string;
}

/**
 * Per-session at-least-once delivery cursor.
 *
 * The hub has had a delivery log and a serve-by-cursor /poll for a while, and nothing used it:
 * the stdio client sends no cursor, so every station is still on the legacy drain path. A
 * hub-hosted station is the first real consumer, because it is the first one that can lose a
 * result it has already been handed.
 *
 * Over stdio a drained batch cannot go missing — the pipe either delivers it or the process is
 * dead. Over Streamable HTTP the result is written to the SSE stream opened for that request,
 * and when that stream drops the SDK deletes the mapping WITHOUT aborting the handler
 * (webStandardStreamableHttp.js). The handler runs to completion, the queue is already drained,
 * and the CallToolResult is written into a stream nobody is reading. The messages are gone.
 *
 * The obvious rule — "commit on the next tool call, since a later call proves the client
 * survived" — does not work, and it is worth being explicit about why: a station whose stream
 * dropped does not stop calling. Its callTool rejects and its agent retries radio_standby. That
 * retry is a "next tool call", so committing on it discards exactly the batch the mechanism
 * exists to recover. Survival of the CLIENT is not receipt of the RESULT.
 *
 * What actually distinguishes the two cases is whether writing the response succeeded, and that
 * IS observable: the transport's send() throws "No connection established for request ID: N"
 * when the stream is gone, and Protocol surfaces it as "Failed to send response: …" on the
 * server's onerror. So: serve without advancing, and on the next call commit only if no send
 * failure was reported in between.
 *
 * If a future SDK reworded that error, this would stop recognising the failure and fall back to
 * committing — i.e. to today's silent-loss behaviour, not to something worse.
 */
export class DeliveryCursor {
  private _committed: number;
  private pending: number | null = null;
  private sendFailed = false;

  constructor(committed = 0) {
    this._committed = committed;
  }

  /** The delivery id polls resume from: the last one the station has PROVEN it received. */
  get committed(): number {
    return this._committed;
  }

  /** Adopt a fresh high-water mark (radio_join): start from "now", not from history. */
  reset(committed: number): void {
    this._committed = committed;
    this.pending = null;
    this.sendFailed = false;
  }

  /** A batch was handed to the transport, ending at `cursor`. Not yet committed. */
  served(cursor: number): void {
    this.pending = cursor;
  }

  /** The transport could not write the last result — the station never saw that batch. */
  responseFailed(): void {
    this.sendFailed = true;
  }

  /** Called at the start of every tool call: promote the served cursor, or discard it. */
  settle(): void {
    if (this.pending === null) return;
    if (this.sendFailed) {
      // Leave `committed` where it is so the next poll re-serves. Duplicates become possible;
      // at-least-once is the trade the deliveries table was built to make.
      this.pending = null;
      this.sendFailed = false;
      return;
    }
    this._committed = this.pending;
    this.pending = null;
  }
}

interface McpSessionEntry {
  sessionId: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  deps: RadioDeps;
  createdAt: number;
  lastActivity: number;
  /** Requests currently inside transport.handleRequest for this session. */
  inFlight: number;
  closing: boolean;
}

const sessions = new Map<string, McpSessionEntry>();
/** Reverse index: callsign -> sessionId. Enforces one live MCP session per callsign. */
const byCallsign = new Map<string, string>();

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * How long a hub-hosted MCP session may sit with NOTHING in flight before the hub closes it.
 *
 * Streamable HTTP is request-scoped: if a station is `kill -9`'d between calls there is no
 * socket for the hub to notice dying on, and the SDK does no session GC of its own. Without a
 * sweeper, dead sessions accumulate and hold callsigns forever.
 *
 * ORDERING INVARIANT — the same shape as the poll-timeout one, and with the same failure mode:
 * this MUST exceed the longest standby window a station may request. The in-flight counter is
 * the real guard (a 20-minute standby is one in-flight request and zero new activity, so any
 * activity-only sweeper would reap exactly the stations behaving correctly), but the default
 * keeps a wide margin anyway. See the note beside resolvePollTimeoutMs in polling.ts.
 */
export function resolveMcpSessionIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WALKIE_TALKIE_MCP_SESSION_IDLE_MS;
  const floor = Math.max(2 * resolveMaxPollWindowMs(env), 30 * 60_000);
  if (raw === undefined || raw === "") return floor;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return floor;
  return n;
}

/** Clamp a station-requested standby window to what the hub will hold a poll open for. */
function clampHubStandbyMs(requestedMs: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const fallback = resolvePollTimeoutMs(env);
  if (requestedMs === undefined || !Number.isFinite(requestedMs) || requestedMs <= 0) return fallback;
  return Math.min(Math.max(requestedMs, 1_000), resolveMaxPollWindowMs(env));
}

/**
 * The hub operations, called in process rather than over a loopback HTTP request.
 *
 * One instance per MCP session, which is what makes the delivery cursor below per-session.
 * Every method re-checks the token: an MCP session carries its token in memory for the life of
 * the session, so without this a kicked or stale-reaped station would keep acting under its
 * callsign because nothing ever looked at the credential again.
 */
class HubLocalOps implements RadioHubClient {
  readonly cursor = new DeliveryCursor();
  baseUrl = "";

  constructor(
    private readonly ops: McpHubOps,
    private readonly sessionIdOf: () => string | undefined,
  ) {}

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Resolve a session token to its callsign and record the station as alive.
   *
   * Throws the bare string "Unauthorized" because radio_standby matches on exactly that to emit
   * its "Registration expired" guidance — the same wording the HTTP 401 path produces.
   */
  private auth(token: string): string {
    const name = getUserByToken(token);
    if (!name) throw new Error("Unauthorized");
    recordSeen(name);
    if (!isOnline(name)) {
      setOnline(name);
      broadcast({ type: "status", name, online: true, timestamp: Date.now() });
    }
    return name;
  }

  async register(
    name: string,
    _joinToken: string,
    oldToken?: string,
  ): Promise<{ token: string; name: string; reclaimed?: boolean }> {
    // The join token was already verified at the HTTP layer for every request on this session,
    // so the argument is redundant here; the callsign claim is what still has to be arbitrated.
    const holder = byCallsign.get(name);
    const mySessionId = this.sessionIdOf();
    if (holder && holder !== mySessionId && sessions.has(holder)) {
      // Refuse rather than let two live sessions believe they own one callsign — even for a
      // caller holding the token. Same wording as the HTTP 409 so stations see one message.
      throw new Error(`User "${name}" is already registered`);
    }
    const outcome = this.ops.registerStation(name, "agent", oldToken);
    if (!outcome.ok) throw new Error(outcome.error);

    if (mySessionId) {
      for (const [callsign, sid] of byCallsign) {
        if (sid === mySessionId && callsign !== outcome.name) byCallsign.delete(callsign);
      }
      byCallsign.set(outcome.name, mySessionId);
    }
    // Start from "now" rather than replaying whatever the callsign was sent before this session
    // existed — the cursor=init semantics, called in process.
    this.cursor.reset(dbGetDeliveryHighWater(outcome.name));
    return { token: outcome.token, name: outcome.name, reclaimed: outcome.reclaimed };
  }

  async unregister(token: string): Promise<void> {
    const name = this.auth(token);
    const role = getUserRole(name);
    removePoll(name);
    removeQueue(name);
    unregisterUser(name);
    byCallsign.delete(name);
    broadcast({ type: "leave", name, timestamp: Date.now() });
    if (role === "agent") notifyBridges(`USER_LEFT: ${name}`);
    console.log(`[unregister] ${name}`);
  }

  async send(
    token: string,
    to: string,
    content: string,
    channel?: string,
    image?: { data: string; mimeType: string },
  ): Promise<{ id: string; to: string }> {
    const name = this.auth(token);
    this.cursor.settle();
    const message = this.ops.sendStationMessage(name, to, content, channel, image);
    return { id: message.id, to: message.to };
  }

  async poll(token: string, timeoutMs?: number, signal?: AbortSignal): Promise<{ messages: RadioMessage[] } | null> {
    const name = this.auth(token);
    this.cursor.settle();
    const result = await awaitPoll(name, this.cursor.committed, clampHubStandbyMs(timeoutMs), signal);
    if (!result || result.messages.length === 0) return null;
    if (result.cursor !== undefined) this.cursor.served(result.cursor);
    return { messages: result.messages };
  }

  async inbox(token: string): Promise<{ messages: RadioMessage[] }> {
    const name = this.auth(token);
    this.cursor.settle();
    // Serve-by-cursor rather than drainQueue, for the same reason poll does: an immediate check
    // whose result is lost must be recoverable. The in-memory queue is discarded to keep it from
    // re-delivering the same messages down the legacy path.
    const { messages, cursor } = dbGetDeliveriesAfter(name, this.cursor.committed);
    drainQueue(name);
    if (messages.length > 0) this.cursor.served(cursor);
    return { messages };
  }

  async users(token: string): Promise<Array<{ name: string; online: boolean; role: string }>> {
    this.auth(token);
    this.cursor.settle();
    return getRegisteredUsers().map((name) => ({
      name,
      online: isOnline(name),
      role: getUserRole(name) ?? "agent",
    }));
  }

  async listChannels(token: string): Promise<Array<{ name: string; memberCount: number; createdBy: string }>> {
    this.auth(token);
    this.cursor.settle();
    const counts = getChannelMemberCounts();
    return dbListChannels().map((ch) => ({
      name: ch.name,
      createdBy: ch.created_by,
      memberCount: counts.get(ch.name) ?? 0,
    }));
  }

  async createChannel(token: string, name: string): Promise<{ channel: string }> {
    const userName = this.auth(token);
    this.cursor.settle();
    const channelName = normalizeChannel(name);
    if (dbGetChannel(channelName)) throw new Error(`Channel "${channelName}" already exists`);
    dbCreateChannel(channelName, userName);
    ensureChannelMembership(channelName);
    joinChannel(channelName, userName);
    broadcast({ type: "channel_create", name: channelName, timestamp: Date.now() });
    broadcast({ type: "channel_join", channel: channelName, userName, timestamp: Date.now() });
    console.log(`[channel-create] ${channelName} by ${userName}`);
    return { channel: channelName };
  }

  async joinChannel(token: string, channel: string): Promise<void> {
    const userName = this.auth(token);
    this.cursor.settle();
    joinChannel(channel, userName);
    broadcast({ type: "channel_join", channel, userName, timestamp: Date.now() });
    console.log(`[channel-join] ${userName} -> ${channel}`);
  }

  async leaveChannel(token: string, channel: string): Promise<void> {
    const userName = this.auth(token);
    this.cursor.settle();
    // Normalised, so "all" cannot slip past the guard the literal "#all" comparison enforces.
    if (normalizeChannel(channel) === "#all") throw new Error("Cannot leave #all");
    leaveChannel(channel, userName);
    broadcast({ type: "channel_leave", channel, userName, timestamp: Date.now() });
    console.log(`[channel-leave] ${userName} <- ${channel}`);
  }

  async inviteToChannel(token: string, channel: string, user: string): Promise<void> {
    const userName = this.auth(token);
    this.cursor.settle();
    const targetName = user.startsWith("@") ? user.slice(1) : user;
    if (!isUserRegistered(targetName)) throw new Error(`User "${targetName}" is not connected`);
    joinChannel(channel, targetName);
    broadcast({ type: "channel_join", channel, userName: targetName, timestamp: Date.now() });
    routeMessage("system", `@${targetName}`, `You have been invited to ${channel} by ${userName}`, channel);
    console.log(`[channel-invite] ${userName} invited ${targetName} to ${channel}`);
  }
}

/** Build the per-session deps: every capability that would act on the HUB's machine is absent. */
function createHubDeps(ops: McpHubOps, client: HubLocalOps): RadioDeps {
  const build = getBuildInfo();
  return {
    client,
    joinToken: ops.joinToken,
    // Remote sessions authenticate the transport with the join token today; per-station keys in
    // the Authorization header are the next phase and will change this to "station-key".
    credentialKind: "join-token",
    session: { token: null, name: null },
    // Prefixed so the `[client …]` marker still answers "what code is serving this station",
    // and is fleet-uniform by construction — which is the whole point of the migration. The
    // stdio clientBuild() would report "source" here: __WT_CLIENT_BUILD__ is an esbuild define
    // applied only to the plugin bundle, and the hub is built with tsc.
    clientBuildLabel: `hub-${build.version}${build.buildRev ? `+${build.buildRev}` : ""}`,
    clampStandbyMs: (requestedMs) => clampHubStandbyMs(requestedMs),
    // readLocalFile: deliberately absent. Present, it would be an arbitrary file read on the
    // container host by any join-token holder.
    fetchRemoteUrl: resolveRemoteFetch(),
    // waitScriptPath: deliberately absent. The listener script lives on a STATION's disk;
    // probing the hub's would answer a question nobody asked.
    tokenStore: nullTokenStore,
  };
}

function closeSession(entry: McpSessionEntry, reason: string, markOffline: boolean, ops: McpHubOps): void {
  if (entry.closing) return;
  entry.closing = true;
  sessions.delete(entry.sessionId);
  const name = entry.deps.session.name;
  if (name && byCallsign.get(name) === entry.sessionId) byCallsign.delete(name);
  console.log(`[mcp] session ${entry.sessionId} closed (${reason})${name ? ` for ${name}` : ""}`);
  // End any standby this session was holding, so hasActivePoll stops claiming a station that
  // no longer has a transport to be answered on. Not routed through onPollDisconnect: the
  // offline decision below is made once, deliberately, rather than twice by two paths.
  if (name) removePoll(name);
  // A closed SESSION is the remote equivalent of a dropped poll socket, and gets the same
  // policy: offline + the stale grace, never an immediate unregister. A station restarting
  // fast then lands inside the grace and can reclaim its own callsign instead of finding it
  // free for a squatter.
  if (markOffline && name) ops.markStationOffline(name);
  void entry.transport.close().catch(() => {});
  void entry.server.close().catch(() => {});
}

let sweeper: ReturnType<typeof setInterval> | null = null;
let currentOps: McpHubOps | null = null;

/**
 * Close MCP sessions that have gone quiet. Exported so the invariant can be tested directly
 * rather than by waiting out a 30-minute window.
 *
 * Returns the number of sessions closed.
 */
export function sweepMcpSessions(idleMs: number = resolveMcpSessionIdleMs(), now: number = Date.now()): number {
  if (!currentOps) return 0;
  let closed = 0;
  for (const entry of [...sessions.values()]) {
    // THE guard. A station 19 minutes into a legitimate radio_standby has exactly one
    // in-flight request and zero new activity, so an activity-only sweeper would reap the
    // stations behaving best — the same ordering mistake that reaped the fleet through the
    // poll-timeout path, in a new place.
    if (entry.inFlight > 0) continue;
    if (now - entry.lastActivity <= idleMs) continue;
    // A long-open GET stamps lastActivity once, when it arrives, so a quiet session's clock
    // does age. That is why the idle default is generous rather than tight: a live station
    // always issues a POST within its standby window, and the window's ceiling is well inside.
    closeSession(entry, `idle for ${Math.round((now - entry.lastActivity) / 1000)}s`, true, currentOps);
    closed += 1;
  }
  return closed;
}

function startSweeper(ops: McpHubOps): void {
  currentOps = ops;
  if (sweeper) return;
  sweeper = setInterval(() => sweepMcpSessions(), DEFAULT_SWEEP_INTERVAL_MS);
  // Never hold the process open for the sweeper.
  sweeper.unref?.();
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/** The base URL a station should be told to reach this hub at (for radio_token's listener). */
function baseUrlFrom(req: IncomingMessage): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || "http";
  const host = (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

/**
 * Build the /mcp request handler. Called once, from createHubServer, which supplies the hub
 * operations as data so this module never has to import back into server.ts.
 */
export function createMcpEndpoint(ops: McpHubOps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  startSweeper(ops);

  return async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = req.headers["mcp-session-id"];
    const id = Array.isArray(sessionId) ? sessionId[0] : sessionId;

    if (id) {
      const entry = sessions.get(id);
      if (!entry) {
        // The spec's "session expired" signal: an SDK client reinitializes on a 404 rather
        // than wedging, which is what a restarted hub needs it to do.
        sendJsonRpcError(res, 404, -32001, "Session not found");
        return;
      }
      (entry.deps.client as HubLocalOps).baseUrl = baseUrlFrom(req);
      // A GET is the standalone notification stream. It is SUPPOSED to sit open for the life of
      // the session, so counting it as in-flight would pin every session open forever and the
      // sweeper could never close anything — including the dead ones it exists to reap. Only a
      // POST (a real JSON-RPC call, and therefore a possible long radio_standby) is protected.
      const counts = req.method !== "GET";
      if (counts) entry.inFlight += 1;
      entry.lastActivity = Date.now();
      try {
        await entry.transport.handleRequest(req, res);
      } finally {
        if (counts) entry.inFlight -= 1;
        entry.lastActivity = Date.now();
      }
      return;
    }

    // No session id: this must be an initialize. One McpServer per transport is not a
    // preference — Protocol.connect() throws on a second transport ("use a separate Protocol
    // instance per connection"), so a shared server with sessionId lookup is not available.
    const client = new HubLocalOps(ops, () => transport.sessionId);
    client.baseUrl = baseUrlFrom(req);
    const deps = createHubDeps(ops, client);
    const server = new McpServer({ name: "walkie-talkie", version: "1.0.0" });
    registerRadioTools(server, deps);
    // The only place the hub learns that a tool result never reached its station: Protocol
    // wraps a failed transport.send as "Failed to send response: …", which happens when the
    // per-request SSE stream has gone. Without this the delivery cursor would commit a batch
    // the station never saw. See DeliveryCursor.
    server.server.onerror = (error: Error) => {
      if (error.message.includes("Failed to send response")) {
        console.warn(`[mcp] result could not be delivered to ${deps.session.name ?? "an unjoined session"}`);
        client.cursor.responseFailed();
      }
    };

    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newId) => {
        const entry: McpSessionEntry = {
          sessionId: newId,
          transport,
          server,
          deps,
          createdAt: Date.now(),
          lastActivity: Date.now(),
          inFlight: 1, // this very request
          closing: false,
        };
        sessions.set(newId, entry);
        console.log(`[mcp] session ${newId} initialized`);
      },
      onsessionclosed: (closedId) => {
        const entry = sessions.get(closedId);
        if (entry) closeSession(entry, "DELETE /mcp", true, ops);
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      const entry = sid ? sessions.get(sid) : undefined;
      if (entry) closeSession(entry, "transport closed", true, ops);
    };

    await server.connect(transport);
    try {
      await transport.handleRequest(req, res);
    } finally {
      const sid = transport.sessionId;
      const entry = sid ? sessions.get(sid) : undefined;
      if (entry) {
        entry.inFlight -= 1;
        entry.lastActivity = Date.now();
      } else {
        // Not an initialize after all (or it failed): nothing was registered, so close the
        // transport we speculatively built rather than leaking it.
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      }
    }
  };
}

/**
 * Close every MCP session on shutdown, so a station's in-flight radio_standby ends rather than
 * hanging until its own tool-call timeout.
 *
 * Deliberately deferred by `graceMs`: hub/src/index.ts enqueues RADIO_KILLED to every
 * registered user before calling this, and that message resolves the in-process standby whose
 * result still has to be serialized onto the SSE stream. Tearing the transport down in the same
 * tick would drop the very message the shutdown path exists to deliver.
 *
 * Stations are NOT marked offline here: the hub is going away entirely, and in-memory
 * registrations do not survive it anyway.
 */
export async function closeAllMcpSessions(graceMs = 150): Promise<void> {
  if (sessions.size === 0) return;
  await new Promise((r) => setTimeout(r, graceMs));
  for (const entry of [...sessions.values()]) {
    entry.closing = true;
    sessions.delete(entry.sessionId);
    if (entry.deps.session.name) byCallsign.delete(entry.deps.session.name);
    await entry.transport.close().catch(() => {});
    await entry.server.close().catch(() => {});
  }
  byCallsign.clear();
}

/** Test seam: how many MCP sessions the hub currently holds. */
/**
 * Close the MCP session holding `name`, if any. The operator-remedy hook: /kick deletes the
 * registration, but a hub-hosted station's callsign is ALSO held by the MCP layer's session
 * index, and the radio_join guard refuses any new session a live entry still holds. Without
 * this, a kicked hosted station — or one whose CLI reconnected and left a zombie session —
 * cannot rejoin its own callsign until the idle sweeper fires, which defaults to 30 minutes.
 * Discovered live: a kick freed the roster while the name stayed hostage to a dead session.
 *
 * markOffline is false: the caller has already decided the registration's fate (kick deletes
 * it outright), so arming the stale grace here would resurrect a name the operator just freed.
 */
export function closeMcpSessionFor(name: string): boolean {
  const sid = byCallsign.get(name);
  if (!sid) return false;
  const entry = sessions.get(sid);
  if (!entry) {
    byCallsign.delete(name);
    return false;
  }
  if (!currentOps) return false;
  closeSession(entry, "kicked", false, currentOps);
  return true;
}

export function mcpSessionCount(): number {
  return sessions.size;
}
