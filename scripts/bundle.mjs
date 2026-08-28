import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmod, readFile } from "node:fs/promises";

const outfile = "plugin/dist/mcp-server.mjs";

/**
 * Stamp the bundle with the revision it was built from.
 *
 * A station's MCP server is spawned when its CLI starts, so a fleet mid-rollout is a MIXTURE of
 * bundles and nothing in the protocol revealed which was which — an operator could not tell a
 * station that had picked up a fix from one still running last week's code. The hub reports its
 * own build at /version; this is the client-side counterpart.
 *
 * Falls back to the package version alone outside a git checkout (an unpacked tarball), which is
 * honest about knowing less rather than inventing an identifier.
 */
async function buildId() {
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  try {
    const rev = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
    return `${version}+${rev}${dirty ? "-dirty" : ""}`;
  } catch {
    return version;
  }
}

const id = await buildId();

await build({
  entryPoints: ["mcp-server/src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile,
  external: ["node:*"],
  define: { __WT_CLIENT_BUILD__: JSON.stringify(id) },
});

await chmod(outfile, 0o755);

console.log(`Bundled → ${outfile} (${id})`);
