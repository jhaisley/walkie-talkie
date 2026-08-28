import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  authenticateRequest,
  findUserByKeyId,
  getRegisteredUsers,
  getUser,
  getUserRole,
  getUserToken,
  isUnclaimed,
  isUserRegistered,
  markClaimed,
  registerUser,
  touchSeen,
  unregisterUser,
} from "./auth.js";
import {
  ensureChannelMembership,
  getChannelMemberCounts,
  getChannelMembers,
  isChannelMember,
  joinChannel,
  leaveChannel,
  removeChannel,
} from "./channels.js";
import { getDashboardHTML } from "./dashboard.js";
import {
  dbCreateAgentConfig,
  dbCreateChannel,
  dbDeleteAgentConfig,
  dbDeleteChannel,
  dbDeleteChannelMessages,
  dbDeleteReadCursorsForChannel,
  dbGetAgentConfig,
  dbGetChannel,
  dbGetChannelMessages,
  dbGetDeliveryHighWater,
  dbGetRecentMessages,
  dbGetUnreadCounts,
  dbGetUserChannels,
  dbListAgentConfigs,
  dbListChannels,
  dbListStationKeys,
  dbTouchStationKey,
  dbUpdateAgentConfig,
  dbUpdateReadCursor,
} from "./db.js";
import { addSSEClient, broadcast } from "./events.js";
import {
  createEnrollment,
  DEFAULT_ENROLLMENT_TTL_MS,
  redeemEnrollment,
  resolveStationKey,
  revokeStationKey,
} from "./keys.js";
import { launchAgent } from "./launcher.js";
import {
  addPoll,
  getLastSeen,
  hasActivePoll,
  isOnline,
  onPollDisconnect,
  recordSeen,
  removePoll,
  resolvePollWindowMs,
  setOffline,
  setOnline,
} from "./polling.js";
import {
  drainQueue,
  enqueueAndDeliver,
  ensureQueue,
  notifyBridges,
  removeQueue,
  routeMessage,
  takeLastRecipientCount,
} from "./router.js";
import type { RegisterRequest, RouteHandler, SendRequest, UserRole } from "./types.js";
import { getBuildInfo } from "./version.js";

const AGENT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Callsigns a client may not claim through /register. Compared case-insensitively: the dashboard
 * matches `from === "operator"` exactly, so a differently-cased variant would not inherit the
 * styling, but it would still be a confusing impersonation and nothing legitimate needs it.
 */
const RESERVED_NAMES = new Set(["operator"]);
export function isReservedName(name: string): boolean {
  return RESERVED_NAMES.has(name.trim().toLowerCase());
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/**
 * The Phase-4 switch. When set, /register stops accepting the shared join token and only a
 * per-station key will do.
 *
 * Off by default and read at call time, so flipping the fleet over is an env change in
 * docker-compose.yml and the revert is the same change backwards — no rebuild, no reinstall,
 * and no window in which a station cannot get back on. Do not flip it until
 * GET /admin-station-keys shows a last_used_at for every callsign, the slack bridge included.
 */
export function resolveRequireStationKey(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.WALKIE_TALKIE_REQUIRE_STATION_KEY;
  if (raw === undefined || raw === "") return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

const handleRegister: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as RegisterRequest;

  // A station key binds a credential to ONE callsign, so identity stops being a self-declaration.
  // Dispatch has already accepted this request on either the join token or a key; resolving it
  // again here (one indexed read, once per station lifetime) is what lets handleRegister know
  // which it was without widening RouteHandler for the benefit of a single route.
  const key = resolveStationKey(req);

  let name: string;
  let role: UserRole;

  if (key) {
    // The body's name is advisory and checked, never applied. Overriding it silently would leave
    // a station whose own transcript says "bravo" registered as "alpha" — a mislabelled station
    // is a worse failure than an error the operator can read.
    // An absent, empty, or whitespace-only name is an ABSENCE, not a disagreement — answering
    // `not ""` would be a baffling 403 for a client that simply did not send one.
    const claimed = typeof body.name === "string" ? body.name.trim() : "";
    if (claimed !== "" && claimed !== key.callsign) {
      return sendError(res, 403, `Key is bound to callsign "${key.callsign}", not "${claimed}"`);
    }
    name = key.callsign;
    // Role comes from the key row, not the body. Until now `role` was caller-chosen, and
    // router.ts notifyBridges() fans every join/leave event to everyone holding "bridge" — so a
    // shared-token holder could self-declare as a bridge and subscribe to the fleet's membership
    // feed. Deriving it from the key closes that. NOTE: the slack bridge's key must therefore be
    // minted with role "bridge", or it silently demotes to agent and stops seeing USER_JOINED.
    role = key.role === "bridge" ? "bridge" : "agent";
  } else {
    if (resolveRequireStationKey()) {
      return sendError(
        res,
        403,
        "This hub requires a per-station key. Ask the operator for an enrollment code and re-run the installer with it.",
      );
    }
    if (!body.name || typeof body.name !== "string") {
      return sendError(res, 400, "Missing or invalid 'name' field");
    }
    // "operator" is the dashboard's identity, and it is created lazily by handleAdminSend on the
    // first admin message rather than seeded at boot. Registrations live only in memory, so every
    // hub restart leaves the name unclaimed until someone sends from the dashboard — and in that
    // window any holder of the join token could take it via /register.
    //
    // That matters more than an ordinary name collision: the dashboard renders anything `from`
    // "operator" with operator styling, agents are instructed to execute operator messages as
    // tasks, and /kick-all deliberately skips the name, so a squatter is immune to the bulk
    // remedy. Reserving it closes the window without needing per-identity auth, which the join
    // token does not provide. Nothing legitimate registers it this way: the dashboard never calls
    // /register, and handleAdminSend calls registerUser() directly.
    if (isReservedName(body.name)) {
      return sendError(res, 403, `"${body.name}" is a reserved name and cannot be registered`);
    }
    name = body.name;
    role = body.role === "bridge" ? "bridge" : "agent";
  }

  try {
    // Whether this call took over a registration that was still held. Reported back so the
    // client does not have to infer it: comparing the old and new tokens looks equivalent but
    // is not, because a fresh register also mints a new token — a station whose name had
    // already been reaped would then be told it reclaimed something when it started clean.
    const reclaimed = isUserRegistered(name);
    if (reclaimed) {
      const incumbent = getUser(name);
      // THREE independent proofs, in descending strength. isReservedName has already run above
      // all of them, so "operator" is never takeable by any route.
      //
      // 1. The key. The strong one: it survives the client restarting, the hub restarting, and
      //    the station losing its token file, so a key holder never has to be reaped out of its
      //    own callsign. It cannot fire during migration, though — an incumbent registered on the
      //    shared join token has no keyId — which is why 2 must stay.
      // 2. The old token. The legacy proof, and the ONLY door open to a station that has just
      //    been enrolled with a key over a join-token incumbent. Removing it strands the live
      //    fleet mid-migration; a client that stops offering it 409s on its own callsign.
      // 3. Unclaimed. A registration restored from the DB at boot that nobody has authenticated
      //    as yet is a HINT, not a lock. A station whose client-side token is gone has nothing to
      //    prove with, and before persistence the restart itself freed the name and it self-healed.
      //    Without this, persistence turns that self-healing case into a permanent 409 that no
      //    stale timer ever releases — the reaper is armed only by a poll disconnect, and a
      //    restored entry has never polled. It concedes nothing new: /register is gated by the
      //    SHARED join token, so any holder could already claim any free callsign. It bounds a
      //    window that used to be unbounded, closing at the real station's first authenticated
      //    request (markClaimed at the protected-route gate).
      const provenByKey = key !== null && incumbent?.keyId !== undefined && incumbent.keyId === key.id;
      const provenByToken = Boolean(body.oldToken) && body.oldToken === incumbent?.token;
      const takeable = isUnclaimed(name);
      if (!provenByKey && !provenByToken && !takeable) {
        return sendError(res, 409, `User "${name}" is already registered`);
      }
      if (!provenByKey && !provenByToken) {
        // The one place a callsign changes hands without proof. Loud on purpose.
        console.log(`[register-takeover] ${name} claimed an unclaimed restored registration (no proof)`);
      }
      removePoll(name);
      removeQueue(name);
      unregisterUser(name);
    }
    // Cancel grace timer if reconnecting
    const graceTimer = staleTimers.get(name);
    if (graceTimer) {
      clearTimeout(graceTimer);
      staleTimers.delete(name);
    }
    const user = registerUser(name, role, key?.id);
    // Stamped here and ONLY here. /poll holds one open request per station continuously, so
    // stamping on every authenticated request would put a SQLite transaction on every poll wake
    // across the fleet; /register happens once per station lifetime. This is also the field the
    // operator reads to decide whether the fleet has finished migrating.
    if (key) dbTouchStationKey(key.id);
    // Whoever just registered holds the new token, so the takeover window is closed either way.
    markClaimed(name);
    ensureQueue(name);
    setOnline(name);
    // Auto-join #all
    try {
      joinChannel("#all", name);
    } catch {
      /* already joined or channel issue */
    }
    // Restore previous channel memberships from DB
    const previousChannels = dbGetUserChannels(name);
    for (const ch of previousChannels) {
      if (ch === "#all") continue;
      try {
        joinChannel(ch, name);
        broadcast({ type: "channel_join", channel: ch, userName: name, timestamp: Date.now() });
        console.log(`[auto-rejoin] ${name} -> ${ch}`);
      } catch {
        /* channel may no longer exist */
      }
    }
    broadcast({ type: "join", name, timestamp: Date.now() });
    console.log(`[register] ${name}${key ? ` (key ${key.id})` : ""}`);

    if (role === "agent") {
      notifyBridges(`USER_JOINED: ${name}`);
    } else if (role === "bridge") {
      // Send current agent list to the newly connected bridge (even if empty)
      const agents = getRegisteredUsers().filter((n) => n !== name && getUserRole(n) === "agent");
      enqueueAndDeliver(name, {
        id: randomUUID(),
        from: "system",
        to: name,
        content: agents.length > 0 ? `CONNECTED_USERS: ${agents.join(", ")}` : "CONNECTED_USERS: (none)",
        channel: "#all",
        timestamp: Date.now(),
      });
    }

    sendJson(res, 200, { token: user.token, name: user.name, reclaimed });
  } catch (e) {
    sendError(res, 409, (e as Error).message);
  }
};

const handleSend: RouteHandler = async (req, res, userName) => {
  const body = JSON.parse(await readBody(req)) as SendRequest;
  if (!body.to || (!body.content && !body.image)) {
    return sendError(res, 400, "Missing 'to' or 'content' field");
  }
  // Typing indicator: broadcast typing event without routing to chat log
  if (body.content === "TYPING") {
    const channel = body.channel || "#all";
    dbUpdateReadCursor(userName!, channel);
    broadcast({ type: "typing", name: userName!, channel, timestamp: Date.now() });
    console.log(`[typing] ${userName}`);
    return sendJson(res, 200, { id: "typing", to: body.to });
  }
  const content = body.content || "";
  const channel = body.channel || "#all";
  try {
    const message = routeMessage(userName!, body.to, content, channel, body.image);
    const recipients = takeLastRecipientCount();
    broadcast({
      type: "message",
      from: message.from,
      to: message.to,
      content: message.content,
      channel: message.channel,
      timestamp: message.timestamp,
      image: message.image,
    });
    console.log(`[send] ${userName} -> ${body.to} (${channel}): ${content}${body.image ? " [+image]" : ""}`);
    // Registrations now outlive the hub process, so routeMessage's isUserRegistered() gate passes
    // for a station that is registered but has not come back since the last restart. The sender
    // used to get an immediate "User X is not connected"; now the message just queues. That is the
    // semantics we want (registered, merely offline), but losing the signal entirely would leave a
    // station talking to a corpse with a 200 every time. Additive field, so the already-deployed
    // bundles ignore it. Only meaningful for a DM: a broadcast has no single recipient.
    // `recipients` is the count actually enqueued. It is the ONLY signal distinguishing a
    // broadcast that reached the room from one that reached nobody, and boot-time restore makes
    // the second case routine: every persisted channel is given an in-memory member set so
    // channelExists() is true for it, while its members do not return until they re-register.
    // Without this, a send into a fully-absent channel is a 200 with an id — the black hole that
    // channel validation closed, reopened by persistence through a different door.
    const payload: { id: string; to: string; recipients: number; offline?: boolean } = {
      id: message.id,
      to: message.to,
      recipients,
    };
    if (message.to !== "@all") payload.offline = !isOnline(message.to);
    sendJson(res, 200, payload);
  } catch (e) {
    sendError(res, 404, (e as Error).message);
  }
};

const handleInbox: RouteHandler = async (_req, res, userName) => {
  const messages = drainQueue(userName!);
  sendJson(res, 200, { messages });
};

const handlePoll: RouteHandler = async (req, res, userName) => {
  const wasOffline = !isOnline(userName!);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const cursorParam = url.searchParams.get("cursor");

  // cursor=init: establish the delivery high-water mark with no backlog. A client with no
  // persisted cursor (first run, or its cursor file was wiped) calls this once to learn where
  // "now" is, then long-polls with that cursor going forward. Responds immediately.
  if (cursorParam === "init") {
    recordSeen(userName!);
    if (wasOffline) {
      setOnline(userName!);
      broadcast({ type: "status", name: userName!, online: true, timestamp: Date.now() });
    }
    sendJson(res, 200, { messages: [], cursor: dbGetDeliveryHighWater(userName!) });
    return;
  }

  // A numeric cursor selects serve-by-cursor (at-least-once); a malformed value falls back
  // to the legacy drain path (undefined), which is the safe default.
  let cursor: number | undefined;
  if (cursorParam !== null) {
    const n = Number(cursorParam);
    if (Number.isFinite(n)) cursor = n;
  }

  // ?wait=<ms> lets a client pick a window that fits ITS MCP tool-call timeout; absent or
  // unusable falls back to the hub default, so existing clients are unaffected.
  addPoll(userName!, req, res, cursor, resolvePollWindowMs(url.searchParams.get("wait")));
  if (wasOffline) {
    setOnline(userName!);
    broadcast({ type: "status", name: userName!, online: true, timestamp: Date.now() });
  }
};

const handleUsers: RouteHandler = async (_req, res) => {
  const users = getRegisteredUsers().map((name) => ({
    name,
    online: isOnline(name),
    role: getUserRole(name) ?? "agent",
    // Epoch ms of the user's most recent poll (null if never polled). NOTE: stamped at poll
    // START, and a healthy long-poll holds open for the full poll timeout, so a slightly
    // stale lastSeen does NOT by itself mean a dead listener — use hasActivePoll for that.
    lastSeen: getLastSeen(name),
    // True liveness: the user has an open long-poll right now. The reliable "is this
    // subscriber actually listening" signal (lastSeen ages during a quiet healthy poll).
    hasActivePoll: hasActivePoll(name),
  }));
  sendJson(res, 200, { users });
};

const handleUnregister: RouteHandler = async (_req, res, userName) => {
  const role = getUserRole(userName!);
  removePoll(userName!);
  removeQueue(userName!);
  unregisterUser(userName!);
  broadcast({ type: "leave", name: userName!, timestamp: Date.now() });
  if (role === "agent") {
    notifyBridges(`USER_LEFT: ${userName}`);
  }
  console.log(`[unregister] ${userName}`);
  sendJson(res, 200, { ok: true });
};

function kickUser(name: string): boolean {
  if (!getRegisteredUsers().includes(name)) return false;
  const role = getUserRole(name);
  // Send a termination message directly to the target user's queue only
  ensureQueue(name);
  enqueueAndDeliver(name, {
    id: randomUUID(),
    from: "system",
    to: name,
    content: "RADIO_KILLED: You have been disconnected by the operator.",
    channel: "#all",
    timestamp: Date.now(),
  });
  removePoll(name);
  removeQueue(name);
  unregisterUser(name);
  broadcast({ type: "leave", name, timestamp: Date.now() });
  if (role === "agent") {
    notifyBridges(`USER_LEFT: ${name}`);
  }
  console.log(`[kick] ${name}`);
  return true;
}

const handleKick: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { name?: string };
  if (!body.name) {
    return sendError(res, 400, "Missing 'name' field");
  }
  if (kickUser(body.name)) {
    sendJson(res, 200, { ok: true, kicked: body.name });
  } else {
    sendError(res, 404, `User "${body.name}" not found`);
  }
};

const handleKickAll: RouteHandler = async (_req, res) => {
  const agents = [...getRegisteredUsers()].filter((name) => name !== "operator");
  for (const name of agents) {
    kickUser(name);
  }
  sendJson(res, 200, { ok: true, kicked: agents });
};

const handleAdminSend: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    from?: string;
    to?: string;
    content?: string;
    channel?: string;
    image?: { data: string; mimeType: string };
  };
  const from = body.from || "operator";
  if (!body.to || (!body.content && !body.image)) {
    return sendError(res, 400, "Missing 'to' or 'content' field");
  }
  const content = body.content || "";
  const channel = body.channel || "#all";
  // Auto-register the admin sender so agents can reply
  if (!isUserRegistered(from)) {
    try {
      registerUser(from);
      ensureQueue(from);
      try {
        joinChannel("#all", from);
      } catch {
        /* already joined */
      }
      broadcast({ type: "join", name: from, timestamp: Date.now() });
      console.log(`[auto-register] ${from}`);
    } catch {
      /* already registered */
    }
  }
  // Ensure operator is in target channel
  try {
    joinChannel(channel, from);
  } catch {
    /* already joined or channel issue */
  }
  try {
    const message = routeMessage(from, body.to, content, channel, body.image);
    broadcast({
      type: "message",
      from: message.from,
      to: message.to,
      content: message.content,
      channel: message.channel,
      timestamp: message.timestamp,
      image: message.image,
    });
    console.log(`[admin-send] ${from} -> ${body.to} (${channel}): ${content}${body.image ? " [+image]" : ""}`);
    sendJson(res, 200, { id: message.id, to: message.to });
  } catch (e) {
    sendError(res, 404, (e as Error).message);
  }
};

// Channel endpoints
const handleChannelCreate: RouteHandler = async (req, res, userName) => {
  const body = JSON.parse(await readBody(req)) as { name?: string };
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  const channelName = body.name.startsWith("#") ? body.name : `#${body.name}`;
  if (dbGetChannel(channelName)) {
    return sendError(res, 409, `Channel "${channelName}" already exists`);
  }
  try {
    dbCreateChannel(channelName, userName!);
    ensureChannelMembership(channelName);
    // Auto-join the creator
    joinChannel(channelName, userName!);
    broadcast({ type: "channel_create", name: channelName, timestamp: Date.now() });
    broadcast({ type: "channel_join", channel: channelName, userName: userName!, timestamp: Date.now() });
    console.log(`[channel-create] ${channelName} by ${userName}`);
    sendJson(res, 200, { ok: true, channel: channelName });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
};

const handleChannelJoin: RouteHandler = async (req, res, userName) => {
  const body = JSON.parse(await readBody(req)) as { channel?: string };
  if (!body.channel || typeof body.channel !== "string") {
    return sendError(res, 400, "Missing or invalid 'channel' field");
  }
  try {
    joinChannel(body.channel, userName!);
    broadcast({ type: "channel_join", channel: body.channel, userName: userName!, timestamp: Date.now() });
    console.log(`[channel-join] ${userName} -> ${body.channel}`);
    sendJson(res, 200, { ok: true, channel: body.channel });
  } catch (e) {
    sendError(res, 404, (e as Error).message);
  }
};

const handleChannelLeave: RouteHandler = async (req, res, userName) => {
  const body = JSON.parse(await readBody(req)) as { channel?: string };
  if (!body.channel || typeof body.channel !== "string") {
    return sendError(res, 400, "Missing or invalid 'channel' field");
  }
  if (body.channel === "#all") {
    return sendError(res, 400, "Cannot leave #all");
  }
  leaveChannel(body.channel, userName!);
  broadcast({ type: "channel_leave", channel: body.channel, userName: userName!, timestamp: Date.now() });
  console.log(`[channel-leave] ${userName} <- ${body.channel}`);
  sendJson(res, 200, { ok: true, channel: body.channel });
};

const handleChannelInvite: RouteHandler = async (req, res, userName) => {
  const body = JSON.parse(await readBody(req)) as { channel?: string; user?: string };
  if (!body.channel || typeof body.channel !== "string") {
    return sendError(res, 400, "Missing or invalid 'channel' field");
  }
  if (!body.user || typeof body.user !== "string") {
    return sendError(res, 400, "Missing or invalid 'user' field");
  }
  const targetName = body.user.startsWith("@") ? body.user.slice(1) : body.user;
  if (!isUserRegistered(targetName)) {
    return sendError(res, 404, `User "${targetName}" is not connected`);
  }
  try {
    joinChannel(body.channel, targetName);
    broadcast({ type: "channel_join", channel: body.channel, userName: targetName, timestamp: Date.now() });
    // Notify the invited user via a system message in the channel
    routeMessage("system", `@${targetName}`, `You have been invited to ${body.channel} by ${userName}`, body.channel);
    console.log(`[channel-invite] ${userName} invited ${targetName} to ${body.channel}`);
    sendJson(res, 200, { ok: true, channel: body.channel, user: targetName });
  } catch (e) {
    sendError(res, 400, (e as Error).message);
  }
};

const handleListChannels: RouteHandler = async (_req, res) => {
  const channels = dbListChannels();
  const memberCounts = getChannelMemberCounts();
  const result = channels.map((ch) => ({
    name: ch.name,
    createdBy: ch.created_by,
    createdAt: ch.created_at,
    memberCount: memberCounts.get(ch.name) ?? 0,
    members: getChannelMembers(ch.name),
  }));
  sendJson(res, 200, { channels: result });
};

const handleChannelHistory: RouteHandler = async (req, res, userName) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const channel = url.searchParams.get("channel");
  if (!channel) {
    return sendError(res, 400, "Missing 'channel' query parameter");
  }
  if (!isChannelMember(channel, userName!)) {
    return sendError(res, 403, `You are not a member of ${channel}`);
  }
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 200);
  const messages = dbGetChannelMessages(channel, limit);
  sendJson(res, 200, { messages });
};

const handleAdminChannelCreate: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { name?: string };
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  const channelName = body.name.startsWith("#") ? body.name : `#${body.name}`;
  if (dbGetChannel(channelName)) {
    return sendError(res, 409, `Channel "${channelName}" already exists`);
  }
  try {
    dbCreateChannel(channelName, "operator");
    ensureChannelMembership(channelName);
    broadcast({ type: "channel_create", name: channelName, timestamp: Date.now() });
    console.log(`[admin-channel-create] ${channelName}`);
    sendJson(res, 200, { ok: true, channel: channelName });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
};

const handleAdminChannelHistory: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const channel = url.searchParams.get("channel");
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 1), 500);
  if (channel) {
    const messages = dbGetChannelMessages(channel, limit);
    sendJson(res, 200, { messages });
  } else {
    const messages = dbGetRecentMessages(limit);
    sendJson(res, 200, { messages });
  }
};

const handleAdminChannelDelete: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { name?: string };
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  if (body.name === "#all") {
    return sendError(res, 400, "Cannot delete #all");
  }
  if (!dbGetChannel(body.name)) {
    return sendError(res, 404, `Channel "${body.name}" not found`);
  }
  dbDeleteChannel(body.name);
  dbDeleteChannelMessages(body.name);
  dbDeleteReadCursorsForChannel(body.name);
  removeChannel(body.name);
  broadcast({ type: "channel_delete", name: body.name, timestamp: Date.now() });
  console.log(`[admin-channel-delete] ${body.name}`);
  sendJson(res, 200, { ok: true, channel: body.name });
};

const handleAdminMarkRead: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { channel?: string; timestamp?: number };
  if (!body.channel || typeof body.channel !== "string") {
    return sendError(res, 400, "Missing or invalid 'channel' field");
  }
  const ts = body.timestamp ?? Date.now();
  dbUpdateReadCursor("operator", body.channel, ts);
  broadcast({ type: "read_update", userName: "operator", channel: body.channel, timestamp: ts });
  sendJson(res, 200, { ok: true });
};

const handleAdminUnreadCounts: RouteHandler = async (_req, res) => {
  const counts = dbGetUnreadCounts("operator");
  sendJson(res, 200, { counts });
};

// Agent config endpoints
const handleAdminAgentConfigs: RouteHandler = async (_req, res) => {
  const configs = dbListAgentConfigs();
  const result = configs.map((c) => ({
    id: c.id,
    name: c.name,
    workDir: c.work_dir,
    command: c.command,
    autoStart: c.auto_start === 1,
    envVars: c.env_vars ? JSON.parse(c.env_vars) : {},
    createdAt: c.created_at,
    online: isUserRegistered(c.name) && isOnline(c.name),
  }));
  sendJson(res, 200, { configs: result });
};

const handleAdminAgentConfigCreate: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    name?: string;
    workDir?: string;
    command?: string;
    autoStart?: boolean;
    envVars?: Record<string, string>;
  };
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  if (!AGENT_NAME_RE.test(body.name)) {
    return sendError(res, 400, "Agent name must contain only a-z, 0-9, hyphen, underscore");
  }
  if (!body.workDir || typeof body.workDir !== "string") {
    return sendError(res, 400, "Missing or invalid 'workDir' field");
  }
  try {
    const id = randomUUID();
    const config = dbCreateAgentConfig(
      id,
      body.name,
      body.workDir,
      body.command || "",
      body.autoStart ?? false,
      body.envVars,
    );
    broadcast({ type: "agent_config_create", id: config.id, name: config.name, timestamp: Date.now() });
    console.log(`[agent-config-create] ${config.name}`);
    sendJson(res, 200, { ok: true, id: config.id });
  } catch (e) {
    sendError(res, 409, (e as Error).message);
  }
};

const handleAdminAgentConfigUpdate: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    id?: string;
    name?: string;
    workDir?: string;
    autoStart?: boolean;
    envVars?: Record<string, string> | null;
  };
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing or invalid 'id' field");
  }
  if (body.name && !AGENT_NAME_RE.test(body.name)) {
    return sendError(res, 400, "Agent name must contain only a-z, 0-9, hyphen, underscore");
  }
  const config = dbGetAgentConfig(body.id);
  if (!config) {
    return sendError(res, 404, "Agent config not found");
  }
  if (isUserRegistered(config.name)) {
    return sendError(res, 409, "Agent is currently online. Kick it first.");
  }
  dbUpdateAgentConfig(body.id, {
    name: body.name,
    workDir: body.workDir,
    autoStart: body.autoStart,
    envVars: body.envVars,
  });
  const name = body.name ?? config.name;
  broadcast({ type: "agent_config_update", id: body.id, name, timestamp: Date.now() });
  console.log(`[agent-config-update] ${name}`);
  sendJson(res, 200, { ok: true });
};

const handleAdminAgentConfigDelete: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { id?: string };
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing or invalid 'id' field");
  }
  const configToDelete = dbGetAgentConfig(body.id);
  if (!configToDelete) {
    return sendError(res, 404, "Agent config not found");
  }
  if (isUserRegistered(configToDelete.name)) {
    return sendError(res, 409, "Agent is currently online. Kick it first.");
  }
  if (!dbDeleteAgentConfig(body.id)) {
    return sendError(res, 404, "Agent config not found");
  }
  broadcast({ type: "agent_config_delete", id: body.id, timestamp: Date.now() });
  console.log(`[agent-config-delete] ${body.id}`);
  sendJson(res, 200, { ok: true });
};

const handleAdminAgentStart: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { id?: string };
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing or invalid 'id' field");
  }
  const config = dbGetAgentConfig(body.id);
  if (!config) {
    return sendError(res, 404, "Agent config not found");
  }
  try {
    await launchAgent(config);
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
};

/**
 * Issuance moved to the hub because the installer cannot do it: installer/render.sh is a sed
 * substitution over a static template served by an nginx with `autoindex on` and no auth, so it
 * has no database, cannot mint anything, and hands its baked-in secret to anyone who can reach
 * the port. The hub already has admin auth and the DB.
 *
 * What the operator gets back is a CODE, not a key. The key itself is minted at redemption and
 * shown once to the machine that redeemed it, so the secret never touches the operator's browser
 * and is never stored anywhere in recoverable form.
 */
const handleAdminStationKeyCreate: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    callsign?: string;
    role?: string;
    label?: string;
    ttlMinutes?: number;
  };
  const callsign = (body.callsign ?? "").trim();
  if (!callsign) {
    return sendError(res, 400, "Missing 'callsign' field");
  }
  if (!AGENT_NAME_RE.test(callsign)) {
    return sendError(res, 400, "Callsign must contain only letters, numbers, hyphens and underscores");
  }
  // Reserved names are refused here too, not just on the join-token path. A key bound to
  // "operator" would otherwise walk straight past isReservedName, since the key branch of
  // handleRegister never consults it — the reservation would have been a patch with a hole.
  if (isReservedName(callsign)) {
    return sendError(res, 403, `"${callsign}" is a reserved name and cannot be issued a key`);
  }
  const role: UserRole = body.role === "bridge" ? "bridge" : "agent";
  // Converted to ms BEFORE flooring, so a sub-minute ttl is honoured rather than silently
  // rounding to zero (and to nothing, since a zero ttl would then fall back to the default).
  const requestedTtlMs =
    typeof body.ttlMinutes === "number" && Number.isFinite(body.ttlMinutes) ? Math.floor(body.ttlMinutes * 60_000) : 0;
  const ttlMs = requestedTtlMs > 0 ? requestedTtlMs : DEFAULT_ENROLLMENT_TTL_MS;
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : null;

  const enrollment = createEnrollment(callsign, role, label, ttlMs);
  console.log(`[station-key] enrollment issued for ${callsign} (role ${role}, ttl ${ttlMs / 60_000}m)`);
  sendJson(res, 200, {
    code: enrollment.code,
    callsign: enrollment.callsign,
    role: enrollment.role,
    expiresAt: enrollment.expiresAt,
    ttlMinutes: Math.round(ttlMs / 60_000),
  });
};

/** Never returns a secret or a hash — there is nothing here an attacker could register with. */
const handleAdminStationKeys: RouteHandler = async (_req, res) => {
  const keys = dbListStationKeys().map((k) => ({
    id: k.id,
    callsign: k.callsign,
    role: k.role,
    label: k.label,
    createdAt: k.created_at,
    createdBy: k.created_by,
    // The migration gate: do not set WALKIE_TALKIE_REQUIRE_STATION_KEY until every callsign
    // (plus the slack bridge) shows one of these.
    lastUsedAt: k.last_used_at,
    revokedAt: k.revoked_at,
  }));
  sendJson(res, 200, { keys });
};

/**
 * Revoke a key AND end the session it is holding.
 *
 * The second half is the non-obvious one. The session token minted at /register never
 * re-consults the key, so flipping revoked_at alone leaves a revoked station sending and
 * polling normally until the stale reaper collects it — 30s by default, and NEVER when
 * WALKIE_TALKIE_STALE_GRACE_MS <= 0, which is exactly the setting a sleep-prone host is advised
 * to use. Revocation that takes effect at the next hub restart is not revocation.
 *
 * Only the session actually proven with THIS key is kicked: a callsign currently registered on
 * the join token, or on a different key, is not someone else's key to end.
 */
const handleAdminStationKeyRevoke: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { id?: string };
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing 'id' field");
  }
  const live = findUserByKeyId(body.id);
  const revoked = revokeStationKey(body.id);
  if (!revoked) {
    return sendError(res, 404, `No active station key with id "${body.id}"`);
  }
  let kicked: string | null = null;
  if (live && kickUser(live.name)) {
    kicked = live.name;
  }
  console.log(`[station-key] revoked ${body.id} (${revoked.callsign})${kicked ? ` and kicked ${kicked}` : ""}`);
  sendJson(res, 200, { ok: true, id: body.id, callsign: revoked.callsign, kicked });
};

/**
 * Failed /enroll attempts per remote address.
 *
 * /enroll is unauthenticated by design — the code IS the credential, and requiring a second one
 * to redeem the first would just move the problem. 128 bits single-use is not brute-forceable,
 * so this counter exists to make a grind VISIBLE rather than to stop it. Deliberately not a
 * block: on a tailnet a shared egress address is normal, and locking out an office because one
 * person mistyped a code would be a worse failure than the attack it prevents.
 */
const enrollFailures = new Map<string, { count: number; firstAt: number }>();
const ENROLL_FAILURE_WINDOW_MS = 10 * 60_000;

function recordEnrollFailure(addr: string): number {
  const now = Date.now();
  // Sweep expired entries on the way past. The map is keyed by remote address and nothing else
  // ever removes from it, so without this a long-running hub accumulates one permanent entry per
  // address that ever fat-fingered a code.
  for (const [key, value] of enrollFailures) {
    if (now - value.firstAt > ENROLL_FAILURE_WINDOW_MS) enrollFailures.delete(key);
  }
  const entry = enrollFailures.get(addr);
  if (!entry) {
    enrollFailures.set(addr, { count: 1, firstAt: now });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

/** Test seam: the counter is process-lifetime state and would otherwise leak between test servers. */
export function resetEnrollFailureState(): void {
  enrollFailures.clear();
}

/**
 * Redeem an enrollment code for a station key. Public, and returns the plaintext key EXACTLY
 * once — nothing can recover it afterwards, including the operator. Losing a key means minting
 * a new code, not retrieving the old key; that is the price of never storing it.
 */
const handleEnroll: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { code?: string };
  const addr = req.socket.remoteAddress ?? "unknown";
  if (!body.code || typeof body.code !== "string") {
    return sendError(res, 400, "Missing 'code' field");
  }
  const redeemed = redeemEnrollment(body.code);
  if (!redeemed) {
    const failures = recordEnrollFailure(addr);
    // One message for every failure mode: unknown, already redeemed, expired. Telling a caller
    // which one it was would confirm that a code exists, which is the only thing a grinder wants.
    console.warn(`[enroll] rejected code from ${addr} (${failures} failure(s) in the last 10 min)`);
    return sendError(res, 403, "Invalid, expired, or already-redeemed enrollment code");
  }
  console.log(
    `[enroll] issued key ${redeemed.keyId} for ${redeemed.callsign} (role ${redeemed.role}) to ${addr}` +
      (redeemed.revokedPredecessorId ? ` — revoked predecessor ${redeemed.revokedPredecessorId}` : ""),
  );
  // A rotation must also end the session the displaced key was holding, for the same reason an
  // explicit revoke does: the old session token outlives its key otherwise.
  if (redeemed.revokedPredecessorId) {
    const live = findUserByKeyId(redeemed.revokedPredecessorId);
    if (live) kickUser(live.name);
  }
  // Scheme is taken from x-forwarded-proto when a proxy set it; the fleet is otherwise plain
  // http over a tailnet. This is a convenience for the installer, not a security boundary.
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || "http";
  const host = req.headers.host ?? "localhost";
  sendJson(res, 200, {
    key: redeemed.key,
    callsign: redeemed.callsign,
    role: redeemed.role,
    hubUrl: `${proto}://${host}`,
  });
};

const handleVersion: RouteHandler = async (_req, res) => {
  sendJson(res, 200, getBuildInfo());
};

const publicRoutes: Record<string, { method: string; handler: RouteHandler }> = {
  "/version": { method: "GET", handler: handleVersion },
  "/users": { method: "GET", handler: handleUsers },
  "/channels": { method: "GET", handler: handleListChannels },
  // Unauthenticated on purpose: the enrollment code is itself the credential. See handleEnroll.
  "/enroll": { method: "POST", handler: handleEnroll },
};

const joinRoutes: Record<string, { method: string; handler: RouteHandler }> = {
  "/register": { method: "POST", handler: handleRegister },
};

const adminRoutes: Record<string, { method: string; handler: RouteHandler }> = {
  "/kick": { method: "POST", handler: handleKick },
  "/kick-all": { method: "POST", handler: handleKickAll },
  "/admin-send": { method: "POST", handler: handleAdminSend },
  "/admin-channel-create": { method: "POST", handler: handleAdminChannelCreate },
  "/admin-channel-delete": { method: "POST", handler: handleAdminChannelDelete },
  "/admin-channel-history": { method: "GET", handler: handleAdminChannelHistory },
  "/admin-mark-read": { method: "POST", handler: handleAdminMarkRead },
  "/admin-unread-counts": { method: "GET", handler: handleAdminUnreadCounts },
  "/admin-agent-configs": { method: "GET", handler: handleAdminAgentConfigs },
  "/admin-agent-config-create": { method: "POST", handler: handleAdminAgentConfigCreate },
  "/admin-agent-config-update": { method: "POST", handler: handleAdminAgentConfigUpdate },
  "/admin-agent-config-delete": { method: "POST", handler: handleAdminAgentConfigDelete },
  "/admin-agent-start": { method: "POST", handler: handleAdminAgentStart },
  "/admin-station-key-create": { method: "POST", handler: handleAdminStationKeyCreate },
  "/admin-station-keys": { method: "GET", handler: handleAdminStationKeys },
  "/admin-station-key-revoke": { method: "POST", handler: handleAdminStationKeyRevoke },
};

const protectedRoutes: Record<string, { method: string; handler: RouteHandler }> = {
  "/send": { method: "POST", handler: handleSend },
  "/poll": { method: "GET", handler: handlePoll },
  "/inbox": { method: "GET", handler: handleInbox },
  "/unregister": { method: "POST", handler: handleUnregister },
  "/channel-create": { method: "POST", handler: handleChannelCreate },
  "/channel-join": { method: "POST", handler: handleChannelJoin },
  "/channel-leave": { method: "POST", handler: handleChannelLeave },
  "/channel-invite": { method: "POST", handler: handleChannelInvite },
  "/channel-history": { method: "GET", handler: handleChannelHistory },
};

function authenticateBearer(req: IncomingMessage, expected: string): boolean {
  const auth = req.headers.authorization;
  if (!auth) return false;
  const [scheme, token] = auth.split(" ");
  return scheme === "Bearer" && token === expected;
}

const DEFAULT_STALE_GRACE_MS = 30_000; // 30 seconds before auto-unregister
const staleTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * How long a poll-disconnected agent keeps its registration before the hub
 * auto-unregisters it (invalidating its token). Configurable via
 * WALKIE_TALKIE_STALE_GRACE_MS (milliseconds); defaults to 30s to preserve
 * the existing behavior. A value <= 0 DISABLES auto-unregister entirely. The
 * agent is marked offline but keeps its registration/token until an explicit
 * unregister/kick.
 *
 * Why configurable: the default 30s is far shorter than a laptop sleep. When the
 * hub runs on a laptop that sleeps overnight, every agent's poll connection drops
 * and 30s later its token is auto-unregistered, so on wake the saved token is
 * dead (401) and the agent can't resume without re-registering. Sleep-prone hosts
 * should set this high (e.g. 86400000 = 24h) or 0 to disable, so a token survives
 * the outage and the agent resumes on the same token. Invalid values fall back to
 * the default.
 */
export function resolveStaleGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WALKIE_TALKIE_STALE_GRACE_MS;
  if (raw === undefined || raw === "") return DEFAULT_STALE_GRACE_MS;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_STALE_GRACE_MS;
}

export function createHubServer(
  port: number,
  adminToken: string,
  joinToken: string,
  host = "127.0.0.1",
): import("node:http").Server {
  const staleGraceMs = resolveStaleGraceMs();

  // When a poll connection drops unexpectedly, mark user offline and start grace timer
  onPollDisconnect((userName) => {
    if (!isUserRegistered(userName)) return;
    setOffline(userName);
    broadcast({ type: "status", name: userName, online: false, timestamp: Date.now() });

    // Grace <= 0 disables auto-unregister: stay registered (token survives) while
    // offline, until an explicit unregister/kick. This is what lets an agent ride
    // out a long laptop sleep and resume on the same token.
    if (staleGraceMs <= 0) {
      console.log(`[offline] ${userName} (auto-unregister disabled)`);
      return;
    }
    console.log(`[offline] ${userName} (grace period ${staleGraceMs / 1000}s)`);

    // Clear any existing grace timer
    const existing = staleTimers.get(userName);
    if (existing) clearTimeout(existing);

    staleTimers.set(
      userName,
      setTimeout(() => {
        staleTimers.delete(userName);
        if (isUserRegistered(userName) && !isOnline(userName)) {
          const role = getUserRole(userName);
          removePoll(userName);
          removeQueue(userName);
          setOffline(userName);
          unregisterUser(userName);
          broadcast({ type: "leave", name: userName, timestamp: Date.now() });
          if (role === "agent") {
            notifyBridges(`USER_LEFT: ${userName}`);
          }
          console.log(`[auto-unregister] ${userName} (stale)`);
        }
      }, staleGraceMs),
    );
  });

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // Dashboard & SSE
    if (path === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      // Optional override for the Connect modal's install URL. Unset is the normal case:
      // the dashboard derives the installer's address from the host it was loaded from, which
      // is correct whenever the two are reached directly. Set this only when the hub is behind
      // a proxy that does not also front the installer.
      res.end(getDashboardHTML(adminToken, process.env.WALKIE_TALKIE_INSTALLER_URL ?? "", getBuildInfo()));
      return;
    }
    if (path === "/events" && req.method === "GET") {
      addSSEClient(res);
      return;
    }

    // Public routes
    const publicRoute = publicRoutes[path];
    if (publicRoute) {
      if (req.method !== publicRoute.method) {
        sendError(res, 405, "Method not allowed");
        return;
      }
      publicRoute.handler(req, res).catch((e) => {
        sendError(res, 500, (e as Error).message);
      });
      return;
    }

    // Join routes (require join token)
    const joinRoute = joinRoutes[path];
    if (joinRoute) {
      if (req.method !== joinRoute.method) {
        sendError(res, 405, "Method not allowed");
        return;
      }
      // Join token OR a per-station key. The short-circuit matters: a station on the current
      // bundle presents the join token, matches on the first test, and never touches the keys
      // table — byte-for-byte the path it takes today, which is what makes this deployable
      // against the live fleet with no client change.
      if (!authenticateBearer(req, joinToken) && !resolveStationKey(req)) {
        sendError(res, 401, "Join token or station key required");
        return;
      }
      joinRoute.handler(req, res).catch((e) => {
        sendError(res, 500, (e as Error).message);
      });
      return;
    }

    // Admin routes (require admin token)
    const adminRoute = adminRoutes[path];
    if (adminRoute) {
      if (req.method !== adminRoute.method) {
        sendError(res, 405, "Method not allowed");
        return;
      }
      if (!authenticateBearer(req, adminToken)) {
        sendError(res, 401, "Admin token required");
        return;
      }
      adminRoute.handler(req, res).catch((e) => {
        sendError(res, 500, (e as Error).message);
      });
      return;
    }

    // User-protected routes (require user token)
    const protectedRoute = protectedRoutes[path];
    if (protectedRoute) {
      if (req.method !== protectedRoute.method) {
        sendError(res, 405, "Method not allowed");
        return;
      }
      const userName = authenticateRequest(req);
      if (!userName) {
        sendError(res, 401, "Unauthorized");
        return;
      }
      // Any authenticated request proves the agent is alive
      if (!isOnline(userName)) {
        setOnline(userName);
        broadcast({ type: "status", name: userName, online: true, timestamp: Date.now() });
      }
      // The single chokepoint every authenticated request passes through, which is why the two
      // registration-persistence side effects live here rather than in each handler.
      // markClaimed: the holder of the token has now proved it, so a restored entry stops being
      // takeable by any join-token holder. touchSeen: keeps the TTL window alive, debounced
      // internally so this is not a DB write per request.
      markClaimed(userName);
      touchSeen(userName);
      protectedRoute.handler(req, res, userName).catch((e) => {
        sendError(res, 500, (e as Error).message);
      });
      return;
    }

    sendError(res, 404, "Not found");
  }

  const server = createServer(handleRequest);
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Error: Port ${port} is already in use. Is another Hub instance running?`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, host, () => {
    console.log(`Walkie-Talkie Hub listening on http://${host}:${port}`);
  });
  return server;
}
