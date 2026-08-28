#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MISSING_CREDENTIAL_MESSAGE, resolveCredential } from "./credential.js";
import { createMcpServer } from "./tools.js";

const args = process.argv.slice(2);
let hubUrl = process.env.HUB_URL || "http://localhost:9559";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--hub" && args[i + 1]) {
    hubUrl = args[i + 1];
    i++;
  }
}

// Either credential will do — see credential.ts. Failing only when BOTH are absent is what
// lets this bundle ship to a fleet that is half on station keys and half on the join token.
const credential = resolveCredential();
if (!credential) {
  console.error(MISSING_CREDENTIAL_MESSAGE);
  process.exit(1);
}

const server = createMcpServer(hubUrl, credential.value, credential.kind);
const transport = new StdioServerTransport();
await server.connect(transport);
