import { randomUUID } from "node:crypto";
import { getRegisteredUsers } from "./auth.js";
import { initGeneralChannel } from "./channels.js";
import { initDB } from "./db.js";
import { closeAllSSEClients } from "./events.js";
import { autoLaunchAgents } from "./launcher.js";
import { closeAllPolls } from "./polling.js";
import { enqueueAndDeliver, ensureQueue } from "./router.js";
import { createHubServer } from "./server.js";

const port = parseInt(process.env.PORT ?? "9559", 10);

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

const server = createHubServer(port, adminToken, joinToken);

// Auto-launch agents only after the server is actually listening
server.on("listening", () => {
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
  // Send RADIO_KILLED to all connected users so they disconnect gracefully
  for (const name of getRegisteredUsers()) {
    ensureQueue(name);
    enqueueAndDeliver(name, {
      id: randomUUID(),
      from: "system",
      to: name,
      content: "RADIO_KILLED: Hub is shutting down.",
      channel: "#all",
      timestamp: Date.now(),
    });
  }
  closeAllSSEClients();
  closeAllPolls();
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
