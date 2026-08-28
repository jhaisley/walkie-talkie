/**
 * Which secret this station registers with.
 *
 * Two env vars are accepted, on purpose and for as long as the fleet is half-migrated:
 *
 *   WALKIE_TALKIE_STATION_KEY   a per-station key bound to one callsign (preferred)
 *   WALKIE_TALKIE_JOIN_TOKEN    the shared fleet-wide join token (legacy)
 *
 * Accepting either is what keeps a partially-migrated fleet a NORMAL state rather than an
 * outage. A bundle that demanded the key would brick every station still configured with the
 * join token, and each of those needs a reinstall plus a CLI restart to fix — the exact cost
 * this whole workstream exists to delete. The key wins when both are set, so a station that has
 * been enrolled uses its key even though its old join-token env var is still lying around in the
 * CLI config.
 */
export type CredentialKind = "station-key" | "join-token";

export interface Credential {
  value: string;
  kind: CredentialKind;
}

export function resolveCredential(env: NodeJS.ProcessEnv = process.env): Credential | null {
  const key = env.WALKIE_TALKIE_STATION_KEY?.trim();
  if (key) return { value: key, kind: "station-key" };
  const joinToken = env.WALKIE_TALKIE_JOIN_TOKEN?.trim();
  if (joinToken) return { value: joinToken, kind: "join-token" };
  return null;
}

export const MISSING_CREDENTIAL_MESSAGE =
  "Error: set WALKIE_TALKIE_STATION_KEY (preferred) or WALKIE_TALKIE_JOIN_TOKEN in the MCP server's environment";
