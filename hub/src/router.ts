import { randomUUID } from "node:crypto";
import { getUserRole, getUsersByRole, isUserRegistered } from "./auth.js";
import { channelExists, getChannelMembers, isChannelMember, normalizeChannel } from "./channels.js";
import { dbRecordDelivery, dbSaveMessage } from "./db.js";
import { deliverMessage } from "./polling.js";
import type { Message, MessageImage } from "./types.js";

const messageQueues = new Map<string, Message[]>();

export function ensureQueue(name: string): void {
  if (!messageQueues.has(name)) {
    messageQueues.set(name, []);
  }
}

export function removeQueue(name: string): void {
  messageQueues.delete(name);
}

/**
 * Drop every in-memory queue, as a fresh process would have it. Exists so a test can simulate a
 * hub restart in-process; a real restart gets this for free. The queues are at-most-once scratch
 * — the durable path is the deliveries log — so losing them here is the honest simulation, not a
 * shortcut.
 */
export function resetRouterState(): void {
  messageQueues.clear();
}

export function drainQueue(name: string): Message[] {
  const queue = messageQueues.get(name);
  if (!queue || queue.length === 0) return [];
  const messages = [...queue];
  queue.length = 0;
  return messages;
}

/**
 * Recipients reached by the most recent routeMessage call. A module-level side channel rather than a
 * changed return type: routeMessage has three callers and only one reports to a client, so widening
 * the signature for all of them buys nothing. Read it immediately after the call.
 */
let lastRecipientCount = 0;

/** Recipients reached by the last routeMessage call. */
export function takeLastRecipientCount(): number {
  return lastRecipientCount;
}

export function routeMessage(
  from: string,
  to: string,
  content: string,
  channel = "#all",
  image?: MessageImage,
): Message {
  // Refuse an unknown channel outright. Previously only the DM path checked anything — it threw
  // "not a member of X" — while @all resolved an unknown channel to an empty member list,
  // delivered to nobody, and returned 200 with a message id. The erroring path was the only one
  // telling the truth, which made the silent path look like the working one. Nine messages
  // reached zero recipients on this deployment before it was noticed.
  if (!channelExists(channel)) {
    throw new Error(
      `Channel "${channel}" does not exist. Check the name with radio_channels, or create it with radio_channel_create.`,
    );
  }
  const normalized = normalizeChannel(channel);
  const members = getChannelMembers(normalized);

  if (to === "@all") {
    const message: Message = {
      id: randomUUID(),
      from,
      to: "@all",
      content,
      channel: normalized,
      timestamp: Date.now(),
      image,
    };

    dbSaveMessage(message);

    const senderRole = getUserRole(from);

    // Deliver to all channel members except sender.
    // When a bridge sends @all, skip other bridges to avoid relay loops.
    let delivered = 0;
    for (const user of members) {
      if (user === from) continue;
      if (senderRole === "bridge" && getUserRole(user) === "bridge") continue;
      enqueueAndDeliver(user, message);
      delivered++;
    }
    // A broadcast to a channel that exists but holds nobody is indistinguishable, to the
    // sender, from one that reached the room — both are a 200 with an id. That is the shape of
    // the black hole channel validation closed, and boot-time restore reopens it: every
    // persisted channel gets an in-memory member set so channelExists() is true, but members do
    // not return until they re-register. Reporting the count keeps the failure visible without
    // making the channel invisible, which would 404 every send until a member came back.
    lastRecipientCount = delivered;
    return message;
  }

  const targetName = to.startsWith("@") ? to.slice(1) : to;

  if (!isUserRegistered(targetName)) {
    throw new Error(`User "${targetName}" is not connected`);
  }

  if (!isChannelMember(normalized, targetName)) {
    throw new Error(`User "${targetName}" is not a member of ${channel}`);
  }

  const message: Message = {
    id: randomUUID(),
    from,
    to: targetName,
    content,
    channel: normalized,
    timestamp: Date.now(),
    image,
  };

  dbSaveMessage(message);

  // Deliver to all channel members except sender
  let delivered = 0;
  for (const user of members) {
    if (user !== from) {
      enqueueAndDeliver(user, message);
      delivered++;
    }
  }
  lastRecipientCount = delivered;
  return message;
}

export function enqueueAndDeliver(targetName: string, message: Message): void {
  // Record the delivery (at-least-once log) at the single routing chokepoint, so the log is
  // exactly the routing output. Phase 1: log only — the in-memory queue below still drives
  // /poll, so behavior is unchanged until the serve-by-cursor path lands.
  dbRecordDelivery(targetName, message);
  ensureQueue(targetName);
  const queue = messageQueues.get(targetName)!;
  queue.push(message);
  deliverMessage(targetName);
}

export function notifyBridges(content: string): void {
  const bridges = getUsersByRole("bridge");
  const message: Message = {
    id: randomUUID(),
    from: "system",
    to: "@bridges",
    content,
    channel: "#all",
    timestamp: Date.now(),
  };
  for (const bridge of bridges) {
    enqueueAndDeliver(bridge, message);
  }
}
