import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build identity for the running hub, surfaced on the dashboard and at GET /version.
 *
 * The recurring operational question is "is this hub actually running the build I just
 * deployed?", which a release number alone cannot answer — this deployment runs upstream
 * 1.7.0 plus local patches, so the version string is a base, not an identity.
 *
 * `startedAt` is what answers it without any build-time plumbing: a hub that started seconds
 * ago is the one you just deployed. `buildRev` sharpens that when the deploy supplies it
 * (WALKIE_TALKIE_BUILD_REV, e.g. the short git SHA of the source tree), and is simply absent
 * otherwise rather than guessed.
 */

/** Read the version from the hub's own package.json, which sits one level above dist/. */
function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.resolve(here, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    // Never let a missing or unreadable manifest take the hub down over a cosmetic field.
    return "unknown";
  }
}

export interface BuildInfo {
  version: string;
  /** Short revision of the deployed source tree, or null when the deploy did not supply one. */
  buildRev: string | null;
  /** Epoch ms at process start — the zero-config "is this the build I just deployed" signal. */
  startedAt: number;
}

const startedAt = Date.now();

export function getBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const rev = env.WALKIE_TALKIE_BUILD_REV?.trim();
  return {
    version: readPackageVersion(),
    buildRev: rev ? rev : null,
    startedAt,
  };
}
