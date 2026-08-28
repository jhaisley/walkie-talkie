import { dbAddChannelMember, dbGetChannel, dbRemoveAllMembersOfChannel, dbRemoveChannelMember } from "./db.js";

const channelMembers = new Map<string, Set<string>>();

/**
 * Canonical form of a channel name.
 *
 * `channelMembers` is keyed by the literal string, so "infra" and "#infra" were two different
 * channels — the first of them empty and non-existent. That is invisible on the broadcast path,
 * which resolves an unknown channel to an empty member list and delivers to nobody while
 * returning success. Nine messages reached zero recipients on this deployment before anyone
 * noticed, one station spending ~35 minutes believing it was talking to a room.
 *
 * Normalising here rather than at each call site means every lookup, join and membership test
 * agrees, whatever the caller passed.
 */
export function normalizeChannel(channel: string): string {
  const trimmed = channel.trim();
  if (trimmed === "") return trimmed;
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

/**
 * Whether a channel exists in memory. Normalisation alone is not enough: a well-formed typo
 * like "#infr" is still a channel nobody is in, and the send path must refuse it rather than
 * broadcast into the void.
 */
export function channelExists(channel: string): boolean {
  return channelMembers.has(normalizeChannel(channel));
}

export function initGeneralChannel(): void {
  if (!channelMembers.has("#all")) {
    channelMembers.set("#all", new Set());
  }
}

export function joinChannel(channel: string, userName: string): void {
  const dbChannel = dbGetChannel(channel);
  if (!dbChannel) {
    throw new Error(`Channel "${channel}" does not exist`);
  }
  let members = channelMembers.get(channel);
  if (!members) {
    members = new Set();
    channelMembers.set(channel, members);
  }
  members.add(userName);
  dbAddChannelMember(channel, userName);
}

export function leaveChannel(channel: string, userName: string): void {
  const members = channelMembers.get(channel);
  if (members) {
    members.delete(userName);
  }
  dbRemoveChannelMember(channel, userName);
}

export function removeUserFromAllChannels(userName: string): void {
  for (const members of channelMembers.values()) {
    members.delete(userName);
  }
}

export function getChannelMembers(channel: string): string[] {
  const members = channelMembers.get(normalizeChannel(channel));
  return members ? Array.from(members) : [];
}

export function getUserChannels(userName: string): string[] {
  const result: string[] = [];
  for (const [channel, members] of channelMembers) {
    if (members.has(userName)) {
      result.push(channel);
    }
  }
  return result;
}

export function isChannelMember(channel: string, userName: string): boolean {
  const members = channelMembers.get(normalizeChannel(channel));
  return members ? members.has(userName) : false;
}

export function getChannelMemberCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [channel, members] of channelMembers) {
    counts.set(channel, members.size);
  }
  return counts;
}

export function ensureChannelMembership(channel: string): void {
  if (!channelMembers.has(channel)) {
    channelMembers.set(channel, new Set());
  }
}

export function removeChannel(channel: string): void {
  channelMembers.delete(channel);
  dbRemoveAllMembersOfChannel(channel);
}

export function resetChannelState(): void {
  channelMembers.clear();
}
