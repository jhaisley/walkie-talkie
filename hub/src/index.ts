import { initGeneralChannel } from "./channels.js";
import { initDB } from "./db.js";
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

createHubServer(port, adminToken, joinToken);
