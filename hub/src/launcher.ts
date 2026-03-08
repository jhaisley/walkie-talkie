import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfigRow } from "./db.js";
import { dbListAgentConfigs } from "./db.js";

let windowOpened = false;

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function createLaunchScript(config: AgentConfigRow): string {
  const nameBase64 = Buffer.from(config.name).toString("base64");
  const scriptPath = join(tmpdir(), `wt-launch-${config.name}-${Date.now()}.sh`);
  const script = `#!/bin/zsh
cd ${shellQuote(config.work_dir)}
rm -f "$0"
printf '\\033]1337;SetBadgeFormat=${nameBase64}\\007'
exec $SHELL
`;
  writeFileSync(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

function openInITerm(config: AgentConfigRow): Promise<void> {
  const scriptPath = createLaunchScript(config);
  const escapedPath = escapeAppleScript(scriptPath);

  const script = windowOpened
    ? [
        'tell application "iTerm2"',
        "  tell current window",
        "    tell current session of current tab",
        `      set newSession to (split vertically with default profile command "${escapedPath}")`,
        "    end tell",
        "  end tell",
        "end tell",
      ].join("\n")
    : ['tell application "iTerm2"', `  create window with default profile command "${escapedPath}"`, "end tell"].join(
        "\n",
      );

  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], (err) => {
      if (err) {
        console.error(`[launcher] Failed to open iTerm2 for ${config.name}: ${err.message}`);
        reject(new Error(`Failed to open iTerm2: ${err.message}`));
      } else {
        console.log(`[launcher] Opened iTerm2 ${windowOpened ? "pane" : "window"} for ${config.name}`);
        windowOpened = true;
        resolve();
      }
    });
  });
}

export function launchAgent(config: AgentConfigRow): Promise<void> {
  return openInITerm(config);
}

export function autoLaunchAgents(): void {
  const configs = dbListAgentConfigs().filter((c) => c.auto_start);
  if (configs.length === 0) return;

  let chain = Promise.resolve();
  for (const config of configs) {
    chain = chain.then(() => {
      console.log(`[auto-launch] ${config.name}`);
      return openInITerm(config);
    });
  }
}
