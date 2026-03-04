import type { IncomingMessage, ServerResponse } from "node:http";
import { drainQueue } from "./router.js";
import type { PendingPoll } from "./types.js";

const POLL_TIMEOUT_MS = 3_600_000; // 1 hour
const pendingPolls = new Map<string, PendingPoll>();

// Track users explicitly detected as offline (poll connection dropped).
// Registered users NOT in this set are considered online (default = online).
const offlineUsers = new Set<string>();

let onDisconnectCallback: ((userName: string) => void) | null = null;

export function onPollDisconnect(cb: (userName: string) => void): void {
  onDisconnectCallback = cb;
}

export function isOnline(userName: string): boolean {
  return !offlineUsers.has(userName);
}

export function setOnline(userName: string): void {
  offlineUsers.delete(userName);
}

export function setOffline(userName: string): void {
  offlineUsers.add(userName);
}

export function addPoll(userName: string, req: IncomingMessage, res: ServerResponse): void {
  removePoll(userName);

  const timer = setTimeout(() => {
    pendingPolls.delete(userName);
    res.writeHead(204);
    res.end();
  }, POLL_TIMEOUT_MS);

  pendingPolls.set(userName, { userName, res, timer });

  // Detect unexpected connection drop (agent crash, network loss).
  // Listen on req (not res) — more reliable when no response has been written yet.
  req.on("close", () => {
    if (!res.writableEnded && pendingPolls.has(userName)) {
      clearTimeout(timer);
      pendingPolls.delete(userName);
      onDisconnectCallback?.(userName);
    }
  });

  // Check if there are already queued messages
  const messages = drainQueue(userName);
  if (messages.length > 0) {
    clearTimeout(timer);
    pendingPolls.delete(userName);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messages }));
  }
}

export function deliverMessage(userName: string): void {
  const poll = pendingPolls.get(userName);
  if (!poll) return;

  const messages = drainQueue(userName);
  if (messages.length === 0) return;

  clearTimeout(poll.timer);
  pendingPolls.delete(userName);

  for (const m of messages) {
    if (m.image) {
      console.log(`[poll-deliver] ${userName} <- image (${m.image.mimeType}, ${m.image.data.length} chars base64)`);
    }
  }

  poll.res.writeHead(200, { "Content-Type": "application/json" });
  poll.res.end(JSON.stringify({ messages }));
}

export function removePoll(userName: string): void {
  const poll = pendingPolls.get(userName);
  if (poll) {
    clearTimeout(poll.timer);
    pendingPolls.delete(userName);
    if (!poll.res.writableEnded) {
      poll.res.writeHead(204);
      poll.res.end();
    }
  }
}
