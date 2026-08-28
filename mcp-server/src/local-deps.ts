import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clampPollWaitMs, HubClient } from "./client.js";
import { resolveWaitScript } from "./helpers.js";
import type { RadioDeps } from "./radio-deps.js";
import { clearStoredToken, readStoredToken, writeStoredToken } from "./token-store.js";
import { clientBuild } from "./version.js";

/**
 * Fetch a URL, following redirects.
 *
 * This runs on the STATION's machine, where "fetch whatever the operator named" is the whole
 * point and the blast radius is the operator's own network. The hub-hosted transport does NOT
 * reuse this: there, following a redirect blindly would let a join-token holder reach the GCP
 * metadata server or an internal service through a redirect the pre-flight check never saw.
 * See hub/src/fetch-guard.ts for the version that re-checks every hop.
 */
function fetchUrl(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith("https") ? https : http;
    transport
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchUrl(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

/**
 * Capabilities for a locally-installed radio: one station, its own machine, its own disk.
 *
 * Every capability is present here, which is what keeps the stdio path byte-identical to the
 * behaviour that shipped before the deps refactor.
 */
export function createLocalDeps(
  hubUrl: string,
  joinToken: string,
  credentialKind: RadioDeps["credentialKind"] = "join-token",
): RadioDeps {
  const client = new HubClient(hubUrl);
  return {
    client,
    joinToken,
    credentialKind,
    session: { token: null, name: null },
    clientBuildLabel: clientBuild(),
    clampStandbyMs: (requestedMs) => clampPollWaitMs(requestedMs),
    readLocalFile: (source) => fs.readFileSync(source),
    fetchRemoteUrl: fetchUrl,
    waitScriptPath: () => resolveWaitScript(path.dirname(fileURLToPath(import.meta.url))),
    tokenStore: {
      read: readStoredToken,
      write: writeStoredToken,
      clear: clearStoredToken,
    },
  };
}
