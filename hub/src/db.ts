import Database from "better-sqlite3";
import path from "node:path";

export interface ChannelRow {
  name: string;
  created_by: string;
  created_at: number;
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
  const rows = db.prepare("SELECT channel FROM channel_members WHERE user_name = ?").all(userName) as { channel: string }[];
  return rows.map((r) => r.channel);
}
