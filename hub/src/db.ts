import path from "node:path";
import Database from "better-sqlite3";

import type { Message, MessageImage, StationEnrollmentRow, StationKeyRow } from "./types.js";

export interface AgentConfigRow {
  id: string;
  name: string;
  work_dir: string;
  command: string;
  auto_start: number;
  env_vars: string | null;
  created_at: number;
}

export interface ChannelRow {
  name: string;
  created_by: string;
  created_at: number;
}

/**
 * A station's registration as persisted. `last_seen_at` stays null until the station makes its
 * first authenticated request, which is why every TTL comparison has to COALESCE it back to
 * `registered_at` rather than treat null as "ancient" and prune a station that just joined.
 */
export interface RegistrationRow {
  name: string;
  token: string;
  role: string;
  registered_at: number;
  last_seen_at: number | null;
}

let db: Database.Database;

export function initDB(): void {
  const dbPath = process.env.WALKIE_TALKIE_DB_PATH ?? path.join(process.cwd(), "walkie-talkie.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      name TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_members (
      channel TEXT NOT NULL,
      user_name TEXT NOT NULL,
      PRIMARY KEY (channel, user_name)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      "from" TEXT NOT NULL,
      "to" TEXT NOT NULL,
      content TEXT NOT NULL,
      channel TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_channel_timestamp
    ON messages (channel, timestamp)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS read_cursors (
      user_name TEXT NOT NULL,
      channel TEXT NOT NULL,
      last_read_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_name, channel)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      work_dir TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT '',
      auto_start INTEGER NOT NULL DEFAULT 0,
      env_vars TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  try {
    db.exec("ALTER TABLE agent_configs ADD COLUMN env_vars TEXT");
  } catch {
    /* column already exists */
  }

  try {
    db.exec("ALTER TABLE messages ADD COLUMN image TEXT");
  } catch {
    /* column already exists */
  }

  // Delivery log for at-least-once delivery (delivery-ack). One row per (recipient, message)
  // recorded at route time — the exact routing output, so serving doesn't re-derive routing.
  // `id` (autoincrement) is the strictly-monotonic per-recipient cursor a client acks against.
  // Phase 1 only writes + reads this; /poll still uses the in-memory queue (no behavior change).
  // message_json is a SELF-CONTAINED snapshot of the delivered message. Earlier the row only
  // referenced messages.id and dbGetDeliveriesAfter JOINed to it — but the messages table
  // prunes #all (a chat-history cap), so a pruned message orphaned its delivery and a cursor
  // client silently skipped it (at-least-once broke). Snapshotting the content here decouples
  // delivery durability from the messages table's lifecycle entirely.
  db.exec(`
    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient TEXT NOT NULL,
      message_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      message_json TEXT
    )
  `);
  // Migration: add message_json to a pre-existing deliveries table. ALTER throws if the column
  // already exists; swallow that so init stays idempotent.
  try {
    db.exec(`ALTER TABLE deliveries ADD COLUMN message_json TEXT`);
  } catch {
    /* column already present */
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_deliveries_recipient_id
    ON deliveries (recipient, id)
  `);

  // Per-station credentials. Replaces "any holder of the ONE shared join token may claim ANY
  // free callsign" with "this key may claim exactly this callsign". Only the sha256 of the
  // secret half is stored, so a database read (or a backup, or a dump in a bug report) yields
  // nothing that can register.
  db.exec(`
    CREATE TABLE IF NOT EXISTS station_keys (
      id           TEXT PRIMARY KEY,
      callsign     TEXT NOT NULL,
      secret_hash  TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'agent',
      label        TEXT,
      created_at   INTEGER NOT NULL,
      created_by   TEXT NOT NULL,
      last_used_at INTEGER,
      revoked_at   INTEGER
    )
  `);
  // One ACTIVE key per callsign, enforced by the schema rather than by convention. This is what
  // makes minting a rotation: dbCreateStationKey revokes the predecessor in the same
  // transaction, so an install command sitting in someone's scrollback is dead rather than a
  // second, equally valid identity for the same station.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_station_keys_active_callsign
    ON station_keys (callsign) WHERE revoked_at IS NULL
  `);

  // One-time enrollment codes. Keyed by sha256(code) — the code is never stored, so this table
  // cannot be read to enrol anything; it can only be used to VERIFY a code someone presents.
  db.exec(`
    CREATE TABLE IF NOT EXISTS station_enrollments (
      code_hash   TEXT PRIMARY KEY,
      callsign    TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'agent',
      label       TEXT,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      redeemed_at INTEGER,
      key_id      TEXT
      )
    `);

  // Station registrations. Until this table existed the roster lived only in auth.ts's Maps, so
  // every hub restart evicted the whole fleet: each station's next call 401'd, which is the same
  // bare symptom as being auto-unregistered by the stale reaper and was repeatedly misdiagnosed as
  // one. The container mounts a volume at /data and WALKIE_TALKIE_DB_PATH points into it, so a row
  // here survives a container restart AND an image rebuild.
  //
  // `token` is stored raw. The same volume already holds the join token and the full message
  // history, and the join token alone lets its holder claim any free callsign, so hashing station
  // tokens would protect nothing that is not already lost if the volume leaks. UNIQUE on token
  // gives the index the auth path would otherwise want, so no separate index is needed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS registrations (
      name          TEXT PRIMARY KEY,
      token         TEXT NOT NULL UNIQUE,
      role          TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      last_seen_at  INTEGER
    )
  `);

  // Operator grants. A persisted privilege flag, deliberately NOT a third UserRole: role is
  // transport/identity (agent vs bridge) and a bridge can be op'd too. Persisted so a grant
  // survives a hub restart — the env-var allow-list it replaces needed a redeploy to change.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ops (
      callsign   TEXT PRIMARY KEY,
      granted_at INTEGER NOT NULL,
      granted_by TEXT NOT NULL
    )
  `);

  // Seed #all if it doesn't exist
  const existing = db.prepare("SELECT name FROM channels WHERE name = ?").get("#all");
  if (!existing) {
    db.prepare("INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?)").run(
      "#all",
      "system",
      Date.now(),
    );
  }
}

export function dbCreateChannel(name: string, createdBy: string): ChannelRow {
  const now = Date.now();
  db.prepare("INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?)").run(name, createdBy, now);
  return { name, created_by: createdBy, created_at: now };
}

export function dbDeleteChannel(name: string): boolean {
  const result = db.prepare("DELETE FROM channels WHERE name = ?").run(name);
  return result.changes > 0;
}

export function dbListChannels(): ChannelRow[] {
  return db.prepare("SELECT name, created_by, created_at FROM channels ORDER BY created_at").all() as ChannelRow[];
}

export function dbGetChannel(name: string): ChannelRow | undefined {
  return db.prepare("SELECT name, created_by, created_at FROM channels WHERE name = ?").get(name) as
    | ChannelRow
    | undefined;
}

export function dbAddChannelMember(channel: string, userName: string): void {
  db.prepare("INSERT OR IGNORE INTO channel_members (channel, user_name) VALUES (?, ?)").run(channel, userName);
}

export function dbRemoveChannelMember(channel: string, userName: string): void {
  db.prepare("DELETE FROM channel_members WHERE channel = ? AND user_name = ?").run(channel, userName);
}

export function dbRemoveAllMembersOfChannel(channel: string): void {
  db.prepare("DELETE FROM channel_members WHERE channel = ?").run(channel);
}

export function dbGetUserChannels(userName: string): string[] {
  const rows = db.prepare("SELECT channel FROM channel_members WHERE user_name = ?").all(userName) as {
    channel: string;
  }[];
  return rows.map((r) => r.channel);
}

// #all chat-history retention cap. This ONLY bounds the dashboard's channel-history view now
// — delivery durability no longer depends on it (deliveries snapshot their own content). The
// upstream default was 200; raised to 5000 (trivial on disk, ~weeks of fleet history) so
// scroll-back is generous. Read queries are independently LIMIT-bounded, so this isn't a
// performance knob. Configurable via WALKIE_TALKIE_ALL_CHANNEL_MAX (read at call time so tests
// and operators can override). Invalid/absent → default.
const DEFAULT_ALL_CHANNEL_MAX = 5000;
function allChannelMax(): number {
  const raw = process.env.WALKIE_TALKIE_ALL_CHANNEL_MAX;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_ALL_CHANNEL_MAX;
}

export function dbSaveMessage(msg: Message): void {
  db.prepare(
    `INSERT INTO messages (id, "from", "to", content, channel, timestamp, image) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.from,
    msg.to,
    msg.content,
    msg.channel,
    msg.timestamp,
    msg.image ? JSON.stringify(msg.image) : null,
  );

  if (msg.channel === "#all") {
    dbPruneAllChannel();
  }
}

function parseMessageRow(row: Record<string, unknown>): Message {
  const imageStr = row.image as string | null;
  return {
    id: row.id as string,
    from: row.from as string,
    to: row.to as string,
    content: row.content as string,
    channel: row.channel as string,
    timestamp: row.timestamp as number,
    image: imageStr ? (JSON.parse(imageStr) as MessageImage) : undefined,
  };
}

/**
 * Record that `message` was routed to `recipient` (the delivery-ack log), snapshotting the
 * full message into the row so the delivery is self-contained — it survives the messages
 * table being pruned out from under it.
 */
/**
 * Per-recipient retention for the delivery log. The log is otherwise INSERT-only: one row per
 * (recipient, message), each carrying a full snapshot of the message. On a fleet, a single #all
 * broadcast writes one row per member and none of them are ever removed, so the table grows
 * without bound for as long as the hub runs — unlike `messages`, which the #all cap prunes.
 *
 * Keeping the newest N per recipient bounds it while leaving at-least-once intact for any client
 * whose cursor is inside the window. This used to be justified by "a client further behind than N
 * messages has already lost its registration to the stale reaper long before, so the guarantee it
 * would be owed is moot" — that premise died when registrations became durable. A station can now
 * be absent for days, survive a hub restart, and come back on the same registration holding a
 * cursor older than the window, in which case it silently skips the overflow. At 2000 rows and a
 * 7-day registration TTL that is not reachable for a small fleet, but the two numbers are now
 * coupled and should be moved together.
 * Configurable via WALKIE_TALKIE_DELIVERY_RETENTION; invalid/absent falls back to the default.
 */
const DEFAULT_DELIVERY_RETENTION = 2000;
function deliveryRetention(): number {
  const raw = process.env.WALKIE_TALKIE_DELIVERY_RETENTION;
  const n = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DELIVERY_RETENTION;
}

/** Trim `recipient`'s delivery log to the newest `deliveryRetention()` rows. */
function dbPruneDeliveries(recipient: string): void {
  const max = deliveryRetention();
  const count = (
    db.prepare("SELECT COUNT(*) AS cnt FROM deliveries WHERE recipient = ?").get(recipient) as { cnt: number }
  ).cnt;
  if (count <= max) return;
  db.prepare(
    `DELETE FROM deliveries WHERE recipient = ? AND id NOT IN (
       SELECT id FROM deliveries WHERE recipient = ? ORDER BY id DESC LIMIT ?
     )`,
  ).run(recipient, recipient, max);
}

export function dbRecordDelivery(recipient: string, message: Message): void {
  db.prepare("INSERT INTO deliveries (recipient, message_id, created_at, message_json) VALUES (?, ?, ?, ?)").run(
    recipient,
    message.id,
    Date.now(),
    JSON.stringify(message),
  );
  dbPruneDeliveries(recipient);
}

/**
 * Messages routed to `recipient` with a delivery id greater than `cursor`, in delivery order.
 * Returns the new cursor (the highest delivery id served, or the input cursor if none) for the
 * client to ack against. The basis of at-least-once: a client re-asks with its last cursor and
 * gets anything it hasn't confirmed.
 *
 * Content comes from the self-contained message_json snapshot. Legacy rows (recorded before
 * the snapshot column) have NULL message_json — for those we LEFT JOIN the messages table as a
 * best-effort fallback, and skip the row only if the message was already pruned (an
 * unrecoverable pre-fix orphan). New rows are never orphaned.
 */
export function dbGetDeliveriesAfter(
  recipient: string,
  cursor: number,
  limit = 200,
): { messages: Message[]; cursor: number } {
  const rows = db
    .prepare(
      `SELECT d.id AS delivery_id, d.message_json AS message_json,
              m.id AS id, m."from" AS "from", m."to" AS "to",
              m.content AS content, m.channel AS channel, m.timestamp AS timestamp, m.image AS image
       FROM deliveries d LEFT JOIN messages m ON m.id = d.message_id
       WHERE d.recipient = ? AND d.id > ?
       ORDER BY d.id ASC LIMIT ?`,
    )
    .all(recipient, cursor, limit) as Record<string, unknown>[];

  const messages: Message[] = [];
  for (const row of rows) {
    const snapshot = row.message_json as string | null;
    if (snapshot) {
      messages.push(JSON.parse(snapshot) as Message);
    } else if (row.id != null) {
      messages.push(parseMessageRow(row)); // legacy row, message still present
    }
    // else: legacy row whose message was pruned — unrecoverable orphan, skip.
  }
  // Cursor always advances to the last delivery id seen (even past a skipped orphan), so a
  // dead pre-fix orphan can never re-wedge the stream the way a parse failure once did.
  const newCursor = rows.length > 0 ? (rows[rows.length - 1].delivery_id as number) : cursor;
  return { messages, cursor: newCursor };
}

/**
 * The current highest delivery id for `recipient` (0 if none). The "now" mark a client with
 * no persisted cursor (first run, or cursor file wiped) adopts via cursor=init, so it starts
 * receiving from this point forward instead of replaying the whole delivery history.
 */
export function dbGetDeliveryHighWater(recipient: string): number {
  const row = db.prepare("SELECT MAX(id) AS hw FROM deliveries WHERE recipient = ?").get(recipient) as {
    hw: number | null;
  };
  return row.hw ?? 0;
}

export function dbGetChannelMessages(channel: string, limit = 50): Message[] {
  const rows = db
    .prepare(
      `SELECT id, "from", "to", content, channel, timestamp, image FROM messages WHERE channel = ? ORDER BY timestamp ASC LIMIT ?`,
    )
    .all(channel, limit) as Record<string, unknown>[];
  return rows.map(parseMessageRow);
}

export function dbGetRecentMessages(limit = 200): Message[] {
  const rows = db
    .prepare(`SELECT id, "from", "to", content, channel, timestamp, image FROM messages ORDER BY timestamp ASC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
  return rows.map(parseMessageRow);
}

export function dbDeleteChannelMessages(channel: string): void {
  db.prepare("DELETE FROM messages WHERE channel = ?").run(channel);
}

export function dbUpdateReadCursor(userName: string, channel: string, timestamp?: number): void {
  const ts = timestamp ?? Date.now();
  db.prepare(
    `INSERT INTO read_cursors (user_name, channel, last_read_at) VALUES (?, ?, ?)
     ON CONFLICT(user_name, channel) DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at)`,
  ).run(userName, channel, ts);
}

export function dbGetUnreadCounts(userName: string): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT m.channel, COUNT(*) as cnt
     FROM messages m
     LEFT JOIN read_cursors rc ON rc.user_name = ? AND rc.channel = m.channel
     WHERE m.timestamp > COALESCE(rc.last_read_at, 0)
     GROUP BY m.channel`,
    )
    .all(userName) as { channel: string; cnt: number }[];
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.channel] = row.cnt;
  }
  return result;
}

export function dbDeleteReadCursorsForChannel(channel: string): void {
  db.prepare("DELETE FROM read_cursors WHERE channel = ?").run(channel);
}

// Agent config CRUD
export function dbCreateAgentConfig(
  id: string,
  name: string,
  workDir: string,
  command: string,
  autoStart: boolean,
  envVars?: Record<string, string>,
): AgentConfigRow {
  const now = Date.now();
  const envJson = envVars ? JSON.stringify(envVars) : null;
  db.prepare(
    "INSERT INTO agent_configs (id, name, work_dir, command, auto_start, env_vars, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, name, workDir, command, autoStart ? 1 : 0, envJson, now);
  return { id, name, work_dir: workDir, command, auto_start: autoStart ? 1 : 0, env_vars: envJson, created_at: now };
}

export function dbListAgentConfigs(): AgentConfigRow[] {
  return db.prepare("SELECT * FROM agent_configs ORDER BY created_at").all() as AgentConfigRow[];
}

export function dbGetAgentConfig(id: string): AgentConfigRow | undefined {
  return db.prepare("SELECT * FROM agent_configs WHERE id = ?").get(id) as AgentConfigRow | undefined;
}

export function dbUpdateAgentConfig(
  id: string,
  updates: {
    name?: string;
    workDir?: string;
    command?: string;
    autoStart?: boolean;
    envVars?: Record<string, string> | null;
  },
): boolean {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) {
    fields.push("name = ?");
    values.push(updates.name);
  }
  if (updates.workDir !== undefined) {
    fields.push("work_dir = ?");
    values.push(updates.workDir);
  }
  if (updates.command !== undefined) {
    fields.push("command = ?");
    values.push(updates.command);
  }
  if (updates.autoStart !== undefined) {
    fields.push("auto_start = ?");
    values.push(updates.autoStart ? 1 : 0);
  }
  if (updates.envVars !== undefined) {
    fields.push("env_vars = ?");
    values.push(updates.envVars ? JSON.stringify(updates.envVars) : null);
  }
  if (fields.length === 0) return false;
  values.push(id);
  const result = db.prepare(`UPDATE agent_configs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

export function dbDeleteAgentConfig(id: string): boolean {
  const result = db.prepare("DELETE FROM agent_configs WHERE id = ?").run(id);
  return result.changes > 0;
}

// Registration persistence. auth.ts keeps its Maps as the request-path cache and writes through
// to these on every mutation, so the DB is the boot-time source of truth and never the hot path.

export function dbUpsertRegistration(name: string, token: string, role: string, registeredAt: number): void {
  // A re-register mints a new token, so last_seen_at is reset to NULL: the new token has not been
  // used yet, and carrying the old stamp forward would make the TTL window start in the past.
  db.prepare(
    `INSERT INTO registrations (name, token, role, registered_at, last_seen_at) VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(name) DO UPDATE SET token = excluded.token, role = excluded.role,
       registered_at = excluded.registered_at, last_seen_at = NULL`,
  ).run(name, token, role, registeredAt);
}

export function dbDeleteRegistration(name: string): void {
  db.prepare("DELETE FROM registrations WHERE name = ?").run(name);
}

export function dbListRegistrations(): RegistrationRow[] {
  return db
    .prepare("SELECT name, token, role, registered_at, last_seen_at FROM registrations ORDER BY registered_at")
    .all() as RegistrationRow[];
}

export function dbTouchRegistrationSeen(name: string, ts: number): void {
  db.prepare("UPDATE registrations SET last_seen_at = ? WHERE name = ?").run(ts, name);
}

/**
 * Drop registrations last seen before `cutoffMs`, returning the names dropped so the caller can
 * log them. This is the ONLY thing that bounds the roster now that a registration outlives the
 * process: the stale reaper is armed exclusively by a poll disconnect, and a restored entry has
 * never had a poll, so without this nothing would ever release a callsign whose station is gone
 * for good.
 */
export function dbPruneRegistrations(cutoffMs: number): string[] {
  const rows = db
    .prepare("SELECT name FROM registrations WHERE COALESCE(last_seen_at, registered_at) < ?")
    .all(cutoffMs) as { name: string }[];
  if (rows.length === 0) return [];
  db.prepare("DELETE FROM registrations WHERE COALESCE(last_seen_at, registered_at) < ?").run(cutoffMs);
  return rows.map((r) => r.name);
}

function dbPruneAllChannel(): void {
  const max = allChannelMax();
  const count = (db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE channel = '#all'").get() as { cnt: number })
    .cnt;
  if (count > max) {
    db.prepare(
      `DELETE FROM messages WHERE channel = '#all' AND id NOT IN (
        SELECT id FROM messages WHERE channel = '#all' ORDER BY timestamp DESC LIMIT ?
      )`,
    ).run(max);
  }
}

// ---------------------------------------------------------------------------------------------
// Station keys and enrollment codes
// ---------------------------------------------------------------------------------------------

/**
 * Insert a station key, revoking whatever active key the callsign already had — both in ONE
 * transaction, because the partial unique index on (callsign) WHERE revoked_at IS NULL would
 * otherwise reject the insert. Rotation is therefore the default and the only outcome: there
 * is never a moment where a callsign has two live credentials.
 *
 * Returns the id of the key this one displaced, if any, so the caller can terminate that
 * key's live session (a revoked key still holds a session token the hub minted at /register).
 */
export function dbCreateStationKey(row: StationKeyRow): { revokedPredecessorId: string | null } {
  const insert = db.transaction((r: StationKeyRow) => {
    const prior = db.prepare("SELECT id FROM station_keys WHERE callsign = ? AND revoked_at IS NULL").get(r.callsign) as
      | { id: string }
      | undefined;
    if (prior) {
      db.prepare("UPDATE station_keys SET revoked_at = ? WHERE id = ?").run(r.created_at, prior.id);
    }
    db.prepare(
      `INSERT INTO station_keys (id, callsign, secret_hash, role, label, created_at, created_by, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(r.id, r.callsign, r.secret_hash, r.role, r.label, r.created_at, r.created_by);
    return prior?.id ?? null;
  });
  return { revokedPredecessorId: insert(row) as string | null };
}

export function dbGetStationKeyById(id: string): StationKeyRow | undefined {
  return db.prepare("SELECT * FROM station_keys WHERE id = ?").get(id) as StationKeyRow | undefined;
}

export function dbGetActiveStationKeyByCallsign(callsign: string): StationKeyRow | undefined {
  return db.prepare("SELECT * FROM station_keys WHERE callsign = ? AND revoked_at IS NULL").get(callsign) as
    | StationKeyRow
    | undefined;
}

export function dbListStationKeys(): StationKeyRow[] {
  return db.prepare("SELECT * FROM station_keys ORDER BY created_at DESC").all() as StationKeyRow[];
}

/** Revoke a key. Returns the row as it was BEFORE revocation, or null if it was already dead. */
export function dbRevokeStationKey(id: string, at: number = Date.now()): StationKeyRow | null {
  const row = dbGetStationKeyById(id);
  if (!row || row.revoked_at !== null) return null;
  db.prepare("UPDATE station_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, id);
  return row;
}

/**
 * Stamp a key as used. Deliberately NOT called from an authenticated-request hook: /poll holds
 * one open request per station continuously, so a write there would put a SQLite transaction on
 * every poll wake across the fleet. Only /register calls this — once per station lifetime.
 */
export function dbTouchStationKey(id: string, at: number = Date.now()): void {
  db.prepare("UPDATE station_keys SET last_used_at = ? WHERE id = ?").run(at, id);
}

/**
 * How long an expired, never-redeemed enrollment row is kept before being swept. Codes are minted
 * by hand so the table grows slowly, but nothing else ever deletes from it — an INSERT-only table
 * on a long-running hub is unbounded, however slow. Redeemed rows are NOT swept: they are the
 * audit trail tying a key back to the enrollment that issued it, and they are bounded by the
 * number of keys.
 */
const ENROLLMENT_SWEEP_AFTER_MS = 24 * 60 * 60_000;

export function dbCreateEnrollment(row: StationEnrollmentRow): void {
  db.prepare("DELETE FROM station_enrollments WHERE redeemed_at IS NULL AND expires_at < ?").run(
    row.created_at - ENROLLMENT_SWEEP_AFTER_MS,
  );
  db.prepare(
    `INSERT INTO station_enrollments (code_hash, callsign, role, label, created_at, expires_at, redeemed_at, key_id)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(row.code_hash, row.callsign, row.role, row.label, row.created_at, row.expires_at);
}

export function dbGetEnrollment(codeHash: string): StationEnrollmentRow | undefined {
  return db.prepare("SELECT * FROM station_enrollments WHERE code_hash = ?").get(codeHash) as
    | StationEnrollmentRow
    | undefined;
}

/**
 * Redeem a code and mint its key, atomically.
 *
 * The claim is a SINGLE conditional UPDATE — never read-then-write — so two racing redemptions
 * of one code cannot both see it unredeemed and both mint. Only the writer that observes
 * `changes === 1` proceeds; the loser gets null and nothing is inserted, because the whole
 * thing (claim + predecessor revocation + insert) runs in one transaction.
 *
 * The caller generates the key id and secret BEFORE calling, which is what lets the enrollment
 * row record `key_id` in the same statement that claims it. Returns the minted row plus the id
 * of any key it displaced, or null if the code was missing, already redeemed, or expired.
 */
export function dbRedeemEnrollment(
  codeHash: string,
  keyId: string,
  secretHash: string,
  createdBy: string,
  now: number = Date.now(),
): { key: StationKeyRow; revokedPredecessorId: string | null } | null {
  const redeem = db.transaction(() => {
    const claimed = db
      .prepare(
        `UPDATE station_enrollments SET redeemed_at = ?, key_id = ?
         WHERE code_hash = ? AND redeemed_at IS NULL AND expires_at > ?`,
      )
      .run(now, keyId, codeHash, now);
    if (claimed.changes !== 1) return null;

    const enrollment = db.prepare("SELECT * FROM station_enrollments WHERE code_hash = ?").get(codeHash) as
      | StationEnrollmentRow
      | undefined;
    if (!enrollment) return null;

    const prior = db
      .prepare("SELECT id FROM station_keys WHERE callsign = ? AND revoked_at IS NULL")
      .get(enrollment.callsign) as { id: string } | undefined;
    if (prior) {
      db.prepare("UPDATE station_keys SET revoked_at = ? WHERE id = ?").run(now, prior.id);
    }

    const key: StationKeyRow = {
      id: keyId,
      callsign: enrollment.callsign,
      secret_hash: secretHash,
      role: enrollment.role,
      label: enrollment.label,
      created_at: now,
      created_by: createdBy,
      last_used_at: null,
      revoked_at: null,
    };
    db.prepare(
      `INSERT INTO station_keys (id, callsign, secret_hash, role, label, created_at, created_by, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(key.id, key.callsign, key.secret_hash, key.role, key.label, key.created_at, key.created_by);

    return { key, revokedPredecessorId: prior?.id ?? null };
  });
  return redeem() as { key: StationKeyRow; revokedPredecessorId: string | null } | null;
}

// ---- operator grants ------------------------------------------------------------------------

export function dbIsOp(callsign: string): boolean {
  return db.prepare("SELECT 1 FROM ops WHERE callsign = ?").get(callsign) !== undefined;
}

export function dbListOps(): Array<{ callsign: string; granted_at: number; granted_by: string }> {
  return db.prepare("SELECT callsign, granted_at, granted_by FROM ops ORDER BY granted_at").all() as Array<{
    callsign: string;
    granted_at: number;
    granted_by: string;
  }>;
}

export function dbGrantOp(callsign: string, grantedBy: string): boolean {
  const r = db
    .prepare("INSERT OR IGNORE INTO ops (callsign, granted_at, granted_by) VALUES (?, ?, ?)")
    .run(callsign, Date.now(), grantedBy);
  return r.changes > 0;
}

export function dbRevokeOp(callsign: string): boolean {
  return db.prepare("DELETE FROM ops WHERE callsign = ?").run(callsign).changes > 0;
}

export function dbOpsCount(): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM ops").get() as { c: number }).c;
}
