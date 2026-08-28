/**
 * System notices whose exact wording is load-bearing on the client side.
 *
 * Its own module because index.ts self-starts and calls process.exit, so a constant declared there
 * cannot be imported by a test. The guard in messages.test.ts is the point of the file.
 */

/**
 * What the hub tells the fleet on SIGINT/SIGTERM.
 *
 * This used to be `RADIO_KILLED: Hub is shutting down.`, which was coherent only while a restart
 * really did destroy every registration. mcp-server/src/tools.ts matches the RADIO_KILLED: prefix,
 * nulls out its token and callsign, and returns "Do NOT call any more radio tools. Stop
 * immediately."; SKILL.md instructs the model the same way and names "a hub shutdown" explicitly;
 * the Slack bridge halts its poll loop on it. Now that registrations survive a restart, sending
 * that on a graceful restart would restore a full roster of stations that have all been told to go
 * dark permanently — a worse outcome than the eviction this change removes.
 *
 * The new prefix is deliberately one the deployed bundles do NOT match: an unpatched client falls
 * through to rendering it as an ordinary system message, so nothing has to be reinstalled for this
 * to be safe. Do not move it back under RADIO_KILLED: — that is what the test guards.
 */
export const HUB_SHUTDOWN_NOTICE =
  "HUB_RESTARTING: The hub is going down for a restart. Your registration and token are preserved — " +
  "wait a few seconds and call radio_standby again. Do NOT radio_join and do NOT stop.";
