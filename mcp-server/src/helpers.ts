import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the on-disk path to `radio-wait.sh`.
 *
 * The script ships only in `plugin/bin/`, but `radio_token` resolves it
 * relative to the running module — whose location differs by entry point:
 *   - bundled `plugin/dist/*.mjs` → `../bin/radio-wait.sh`
 *   - built `mcp-server/dist/*`   → `../../plugin/bin/radio-wait.sh`
 *
 * Probing both candidates and returning the first that exists keeps
 * `radio_token` honest regardless of which entry runs. Regression: the old
 * single-candidate `../bin` logic returned a nonexistent `mcp-server/bin/`
 * path when the server ran from the `mcp-server/dist` build.
 *
 * `exists` is injectable for testing; it defaults to `fs.existsSync`.
 */
export function resolveWaitScript(thisDir: string, exists: (p: string) => boolean = fs.existsSync): string | null {
  const candidates = [
    path.resolve(thisDir, "..", "bin", "radio-wait.sh"),
    path.resolve(thisDir, "..", "..", "plugin", "bin", "radio-wait.sh"),
  ];
  // Returns null rather than a plausible-looking guess. The previous fallback to candidates[0]
  // meant a station that had never been shipped the script still received a confident absolute
  // path to it — and no installer ships it, so that was EVERY installed station. Probing the
  // right locations cannot help when the file is at none of them; the honest answer is "absent".
  return candidates.find(exists) ?? null;
}

/**
 * Render the hub's connected-user list for `radio_channels`.
 *
 * The hub returns user OBJECTS (`{ name, online, role }`), so rendering must
 * project to `name`. Regression: joining the raw objects printed
 * "[object Object]". Offline users are marked because the hub already
 * provides the flag and it helps spot stale registrations.
 */
export function formatConnectedUsers(users: Array<{ name: string; online: boolean }>): string {
  if (users.length === 0) return "No users connected.";
  const rendered = users.map((u) => (u.online ? u.name : `${u.name} (offline)`)).join(", ");
  return `Connected users: ${rendered}`;
}
