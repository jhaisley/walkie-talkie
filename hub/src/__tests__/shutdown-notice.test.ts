import { describe, expect, it } from "vitest";
import { HUB_SHUTDOWN_NOTICE } from "../messages.js";

describe("HUB_SHUTDOWN_NOTICE", () => {
  it("does not use the RADIO_KILLED prefix", () => {
    // A one-line guard against a revert. RADIO_KILLED: is matched by mcp-server/src/tools.ts,
    // which nulls out the client's token and returns "Do NOT call any more radio tools. Stop
    // immediately.", and by the Slack bridge, which halts its poll loop. Sending it on a graceful
    // restart used to be coherent because the restart really did destroy the registration; now
    // that registrations survive, it would restore a full roster of stations that have all been
    // told to stand down permanently.
    expect(HUB_SHUTDOWN_NOTICE.startsWith("RADIO_KILLED:")).toBe(false);
  });

  it("is prefixed so an unpatched deployed bundle renders it as an ordinary system message", () => {
    expect(HUB_SHUTDOWN_NOTICE.startsWith("HUB_RESTARTING:")).toBe(true);
  });

  it("tells the station its registration survives and to resume rather than rejoin", () => {
    expect(HUB_SHUTDOWN_NOTICE).toMatch(/radio_standby/);
    expect(HUB_SHUTDOWN_NOTICE).toMatch(/preserved/);
  });
});
