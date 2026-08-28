import { describe, expect, it } from "vitest";
import { resolveCredential } from "../credential.js";

/**
 * This is the guard against a bundle that bricks every station still on the shared token.
 *
 * The client half of this migration cannot roll out atomically — each station needs a reinstall
 * plus a CLI restart — so a half-migrated fleet has to be a NORMAL state. A resolver that
 * demanded the station key would take every unmigrated station off the air at once, and the
 * remedy for each is exactly the thing that is slow.
 */
describe("resolveCredential", () => {
  it("prefers the station key when both are set", () => {
    const c = resolveCredential({
      WALKIE_TALKIE_STATION_KEY: "wtk_0123456789abcdef_secret",
      WALKIE_TALKIE_JOIN_TOKEN: "shared",
    } as NodeJS.ProcessEnv);
    // Preference, not exclusivity: an enrolled station's CLI config usually still carries the old
    // join-token env var, and it must not win.
    expect(c).toEqual({ value: "wtk_0123456789abcdef_secret", kind: "station-key" });
  });

  it("accepts the station key alone", () => {
    const c = resolveCredential({ WALKIE_TALKIE_STATION_KEY: "wtk_abc" } as NodeJS.ProcessEnv);
    expect(c).toEqual({ value: "wtk_abc", kind: "station-key" });
  });

  it("accepts the join token alone", () => {
    const c = resolveCredential({ WALKIE_TALKIE_JOIN_TOKEN: "shared" } as NodeJS.ProcessEnv);
    expect(c).toEqual({ value: "shared", kind: "join-token" });
  });

  it("returns null only when both are absent", () => {
    expect(resolveCredential({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("treats blank and whitespace-only values as absent", () => {
    // An env var set to "" (a common way to "unset" one in a compose file or a CLI config) must
    // not shadow the other credential — that would be a station bricked by an empty string.
    expect(
      resolveCredential({ WALKIE_TALKIE_STATION_KEY: "", WALKIE_TALKIE_JOIN_TOKEN: "shared" } as NodeJS.ProcessEnv),
    ).toEqual({ value: "shared", kind: "join-token" });
    expect(
      resolveCredential({ WALKIE_TALKIE_STATION_KEY: "   ", WALKIE_TALKIE_JOIN_TOKEN: "shared" } as NodeJS.ProcessEnv),
    ).toEqual({ value: "shared", kind: "join-token" });
    expect(resolveCredential({ WALKIE_TALKIE_JOIN_TOKEN: "  " } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    // Keys arrive by copy-paste through a terminal; a trailing newline must not become part of
    // the credential and produce an unexplainable 401.
    expect(resolveCredential({ WALKIE_TALKIE_STATION_KEY: " wtk_x \n" } as NodeJS.ProcessEnv)?.value).toBe("wtk_x");
  });
});
