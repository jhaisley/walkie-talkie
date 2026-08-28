import { loadPersistedRegistrations, resolveRegistrationTtlMs } from "./auth.js";
import { ensureChannelMembership, joinChannel } from "./channels.js";
import { dbGetUserChannels, dbListChannels } from "./db.js";
import { seedLastSeen, setOffline } from "./polling.js";
import { ensureQueue } from "./router.js";

/**
 * Rebuild the in-memory fleet from the DB at boot.
 *
 * Its own module rather than inline in index.ts for two reasons: index.ts self-starts and calls
 * process.exit, so nothing in it is testable, and auth.ts must not import polling/router (auth
 * already imports channels; adding the other two would deepen the existing router<->polling cycle
 * for no gain).
 *
 * THE TRAP THIS EXISTS TO AVOID: restoring the roster alone is strictly WORSE than not restoring
 * it. channels.ts keeps `channelMembers` in memory and initGeneralChannel() creates an empty #all
 * and nothing else; membership was only ever rebuilt as a side effect of handleRegister, which was
 * safe because every station had to re-register after a restart. Once they stop having to,
 * channelExists("#infra") is false and routeMessage throws "Channel does not exist", while
 * getChannelMembers("#all") is empty so an @all broadcast reaches nobody and a DM fails
 * isChannelMember. That converts "everyone is 401'd" into "everyone is authenticated and nothing
 * can be sent". Steps 1 and 3 below are the fix; registration-persistence.test.ts fails loudly if
 * either is dropped.
 */
export function restoreFleet(ttlMs: number = resolveRegistrationTtlMs()): string[] {
  // 1. Every persisted channel gets an in-memory member set, even one whose members have not come
  // back yet, so channelExists() is true for it. This also fixes a latent (previously
  // self-healing) bug: a channel used to be invisible to channelExists until one of its members
  // re-registered.
  for (const ch of dbListChannels()) {
    ensureChannelMembership(ch.name);
  }

  // 2. Roster: prune by TTL, then repopulate the auth caches.
  const rows = loadPersistedRegistrations(ttlMs);

  const restored: string[] = [];
  for (const row of rows) {
    // Queues are recreated EMPTY on purpose. A message enqueued but not delivered when the hub
    // died is gone from the legacy at-most-once path; it is recoverable only via the cursor path.
    // Persisting registrations is not message persistence.
    ensureQueue(row.name);

    // isOnline() is a deny-set (!offlineUsers.has(name)), so a restored user that was not
    // explicitly marked would report online:true with hasActivePoll:false and no lastSeen — a
    // green dot for a station that may never come back. The flip back to online needs no new
    // code: server.ts promotes any authenticated request, and so does handlePoll.
    setOffline(row.name);

    if (row.last_seen_at !== null) seedLastSeen(row.name, row.last_seen_at);

    // 3. Channel membership. joinChannel re-issues dbAddChannelMember, which is INSERT OR IGNORE,
    // so this is idempotent. Each is guarded because a channel may have been deleted since.
    try {
      joinChannel("#all", row.name);
    } catch {
      /* #all is seeded by initDB, but never let one bad row abort the whole restore */
    }
    for (const ch of dbGetUserChannels(row.name)) {
      if (ch === "#all") continue;
      try {
        joinChannel(ch, row.name);
      } catch {
        /* channel no longer exists */
      }
    }

    restored.push(row.name);
  }

  if (restored.length > 0) {
    console.log(`[restore] ${restored.length} registration(s): ${restored.join(", ")}`);
  } else {
    console.log("[restore] no persisted registrations");
  }
  return restored;
}
