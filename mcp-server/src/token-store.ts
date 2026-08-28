import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Durable store for the session token the hub mints at radio_join.
 *
 * The hub already supports reclaiming a callsign: /register accepts an `oldToken` and lets the
 * proven owner take its registration back. The client side never used it, because the token
 * lived only in a module variable — so any restart of the MCP server (a CLI restart, a crash,
 * a machine reboot) lost it, and the station could not prove ownership of its own name. It then
 * got 409 "already registered" until the stale-registration grace reaped the old entry.
 *
 * That gap is the one real cost of a long standby window: the longer a client may sit in a
 * single poll, the worse it is to come back and find the name locked. Persisting the token
 * closes it — a restarted station reclaims immediately instead of waiting to be reaped.
 *
 * Files are per (hub, callsign) so one machine can hold several callsigns, or the same callsign
 * on different hubs, without collision. Written 0600: the token grants the callsign, and the
 * callsign is what agents trust when they act on a message.
 */

function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WALKIE_TALKIE_STATE_DIR) return env.WALKIE_TALKIE_STATE_DIR;
  const base = env.XDG_STATE_HOME || (env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "state"));
  return path.join(base, "walkie-talkie");
}

/** Filesystem-safe key for a (hub, name) pair. Never used to reconstruct either value. */
export function tokenKey(hubUrl: string, name: string): string {
  const safe = (v: string) => v.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 64);
  return `${safe(hubUrl)}.${safe(name)}.token`;
}

export function readStoredToken(hubUrl: string, name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const v = fs.readFileSync(path.join(stateDir(env), tokenKey(hubUrl, name)), "utf8").trim();
    return v.length > 0 ? v : null;
  } catch {
    // Absent or unreadable is the normal first-run case, never an error worth surfacing.
    return null;
  }
}

export function writeStoredToken(hubUrl: string, name: string, token: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const dir = stateDir(env);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, tokenKey(hubUrl, name));
    // Write-then-rename so a crash mid-write cannot leave a truncated token behind.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, token, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // Best effort: losing persistence costs a reclaim, not the session.
  }
}

export function clearStoredToken(hubUrl: string, name: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    fs.unlinkSync(path.join(stateDir(env), tokenKey(hubUrl, name)));
  } catch {
    /* already gone */
  }
}
