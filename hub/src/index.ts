import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getRegisteredUsers } from "./auth.js";
import { initGeneralChannel } from "./channels.js";
import { initDB } from "./db.js";
import { closeAllSSEClients } from "./events.js";
import { autoLaunchAgents } from "./launcher.js";
import { closeAllMcpSessions } from "./mcp.js";
import { HUB_SHUTDOWN_NOTICE } from "./messages.js";
import { closeAllPolls } from "./polling.js";
import { restoreFleet } from "./restore.js";
import { enqueueAndDeliver, ensureQueue } from "./router.js";
import { createHubServer, seedOpsFromEnv } from "./server.js";

const port = parseInt(process.env.PORT ?? "9559", 10);
const hubHost = process.env.HUB_HOST ?? "127.0.0.1";

const joinToken = process.env.WALKIE_TALKIE_JOIN_TOKEN;
if (!joinToken) {
  console.error("Error: WALKIE_TALKIE_JOIN_TOKEN environment variable is required");
  process.exit(1);
}

const adminToken = process.env.WALKIE_TALKIE_ADMIN_TOKEN;
if (!adminToken) {
  console.error("Error: WALKIE_TALKIE_ADMIN_TOKEN environment variable is required");
  process.exit(1);
}

initDB();
initGeneralChannel();
seedOpsFromEnv();
// Rehydrate the fleet BEFORE the server can accept a request, so no station ever sees the
// half-restored state (authenticated but with no channel memberships).
restoreFleet();

const server = createHubServer(port, adminToken, joinToken, hubHost);

// After the server is listening, open the dashboard and auto-launch agents
server.on("listening", () => {
  execFile("open", [`http://localhost:${port}`], (err) => {
    if (err) console.error(`[open] Failed to open browser: ${err.message}`);
  });
  autoLaunchAgents();
});

// Graceful shutdown
let shuttingDown = false;
function handleShutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // Restore terminal to cooked mode if it was set to raw
  if (process.stdin.isTTY && process.stdin.isRaw) {
    process.stdin.setRawMode(false);
  }
  console.log("\n[shutdown] Notifying connected users...");
  // Tell everyone the hub is going away, but NOT with RADIO_KILLED — that prefix means "you are
  // disconnected, stop calling radio tools, do not rejoin", and a restart no longer destroys the
  // registration it would be telling them about. See messages.ts for why the new prefix is safe
  // to send to the already-deployed bundles.
  for (const name of getRegisteredUsers()) {
    ensureQueue(name);
    enqueueAndDeliver(name, {
      id: randomUUID(),
      from: "system",
      to: name,
      content: HUB_SHUTDOWN_NOTICE,
      channel: "#all",
      timestamp: Date.now(),
    });
  }
  closeAllSSEClients();
  closeAllPolls();
  // Hub-hosted MCP stations do not hold a poll socket, so closeAllPolls does not reach them.
  // Their transports have to be closed explicitly or an in-flight radio_standby hangs until the
  // station's own tool-call timeout. Deliberately not awaited: it defers briefly so the
  // RADIO_KILLED enqueued above can finish being written to each session's SSE stream first,
  // and server.close() below is already waiting on those same connections.
  void closeAllMcpSessions();
  server.close(() => {
    console.log("[shutdown] Hub stopped.");
    process.exit(0);
  });
  // Force exit after 10 seconds
  setTimeout(() => {
    console.error("[shutdown] Force exit after timeout");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGINT", handleShutdown);
process.on("SIGTERM", handleShutdown);
