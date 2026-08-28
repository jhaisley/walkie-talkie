import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RadioDeps, RadioHubClient, RadioMessage } from "../radio-deps.js";
import { registerRadioTools } from "../tools.js";

/**
 * tools.ts had ZERO coverage before this change, which made moving four module globals into a
 * per-session object the riskiest edit in the whole migration: the strings it emits are treated
 * as a contract by fleet tooling, and nothing would have caught a drift.
 *
 * These drive the registered tool callbacks directly against a fake RadioDeps. The two things
 * being proved are (1) two sessions cannot see each other's state — the actual bug the globals
 * were — and (2) every capability gate refuses BEFORE doing any I/O.
 */

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;

/** Capture the tool callbacks registered on a server, without needing a transport. */
function captureTools(deps: RadioDeps): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const fake = {
    tool: (name: string, ...rest: unknown[]) => {
      handlers.set(name, rest[rest.length - 1] as ToolHandler);
    },
  } as unknown as McpServer;
  registerRadioTools(fake, deps);
  return handlers;
}

function text(res: ToolResult): string {
  return res.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

interface Fake {
  deps: RadioDeps;
  tools: Map<string, ToolHandler>;
  client: RadioHubClient & { sent: Array<{ token: string; to: string; content: string }> };
}

function makeFake(overrides: Partial<RadioDeps> = {}, hubUrl = "http://hub.test:9559"): Fake {
  const sent: Array<{ token: string; to: string; content: string }> = [];
  const registered = new Map<string, string>();
  const client = {
    sent,
    getBaseUrl: () => hubUrl,
    register: async (name: string, _join: string, oldToken?: string) => {
      const token = `tok-${name}-${registered.size}`;
      const reclaimed = oldToken !== undefined && registered.get(name) === oldToken;
      registered.set(name, token);
      return { token, name, reclaimed };
    },
    unregister: async () => {},
    send: async (token: string, to: string, content: string) => {
      sent.push({ token, to, content });
      return { id: "msg-1", to };
    },
    poll: async (): Promise<{ messages: RadioMessage[] } | null> => null,
    inbox: async () => ({ messages: [] as RadioMessage[] }),
    users: async () => [{ name: "someone", online: true, role: "agent" }],
    listChannels: async () => [{ name: "#all", memberCount: 1, createdBy: "system" }],
    createChannel: async (_t: string, name: string) => ({ channel: name }),
    joinChannel: async () => {},
    leaveChannel: async () => {},
    inviteToChannel: async () => {},
  } as unknown as Fake["client"];

  const deps: RadioDeps = {
    client,
    joinToken: "join-token",
    credentialKind: "join-token",
    session: { token: null, name: null },
    clientBuildLabel: "1.7.0+abc123",
    clampStandbyMs: (ms) => ms ?? 30_000,
    readLocalFile: () => Buffer.from("local-bytes"),
    fetchRemoteUrl: async () => Buffer.from("remote-bytes"),
    waitScriptPath: () => null,
    tokenStore: { read: () => null, write: () => {}, clear: () => {} },
    ...overrides,
  };
  return { deps, tools: captureTools(deps), client };
}

describe("per-session state", () => {
  it("keeps two sessions' tokens and callsigns apart", async () => {
    const a = makeFake();
    const b = makeFake();

    await a.tools.get("radio_join")!({ name: "alpha" });
    await b.tools.get("radio_join")!({ name: "bravo" });

    expect(a.deps.session.name).toBe("alpha");
    expect(b.deps.session.name).toBe("bravo");
    expect(a.deps.session.token).not.toBe(b.deps.session.token);

    // The direct regression test for the module globals: B's send must carry B's token.
    await a.tools.get("radio_over")!({ to: "@bravo", message: "from a" });
    await b.tools.get("radio_over")!({ to: "@alpha", message: "from b" });
    expect(a.client.sent[0].token).toBe(a.deps.session.token);
    expect(b.client.sent[0].token).toBe(b.deps.session.token);
  });

  it("does not let one session's join unlock another session's tools", async () => {
    const a = makeFake();
    const b = makeFake();
    await a.tools.get("radio_join")!({ name: "alpha" });

    for (const name of [
      "radio_over",
      "radio_send_image",
      "radio_check",
      "radio_standby",
      "radio_channels",
      "radio_channel_create",
      "radio_channel_join",
      "radio_channel_leave",
      "radio_channel_invite",
      "radio_token",
    ]) {
      const res = await b.tools.get(name)!({
        to: "@x",
        message: "m",
        source: "/tmp/x.png",
        channel: "#all",
        user: "@y",
        name: "#c",
      });
      // Wording is a contract — stations and operators match on it. It must not drift, and it
      // must be per-session rather than per-process.
      expect(text(res), name).toBe("Not on the air. Use radio_join first.");
      expect(res.isError, name).toBe(true);
    }
    // radio_out is the one tool that answers differently when not registered.
    expect(text(await b.tools.get("radio_out")!({}))).toBe("Not registered.");
  });
});

describe("radio_join text", () => {
  it("is byte-identical to the pre-refactor stdio wording, with the build marker last", async () => {
    const a = makeFake();
    const res = await a.tools.get("radio_join")!({ name: "alpha" });
    expect(text(res)).toBe(
      'Registered as "alpha". You are now in #all. You can now send and receive messages. [client 1.7.0+abc123]',
    );
  });

  it("adds the reclaim clause between the two, in that order", async () => {
    const a = makeFake({ tokenStore: { read: () => "tok-alpha-0", write: () => {}, clear: () => {} } });
    await a.tools.get("radio_join")!({ name: "alpha" }); // seeds the fake registry
    const res = await a.tools.get("radio_join")!({ name: "alpha" });
    expect(text(res)).toBe(
      'Registered as "alpha". You are now in #all. You can now send and receive messages.' +
        " (Reclaimed a previous registration for this callsign.) [client 1.7.0+abc123]",
    );
  });

  it("reports the hub's build label when the hub is serving the tools", async () => {
    const a = makeFake({ clientBuildLabel: "hub-1.7.0+deadbee" });
    const res = await a.tools.get("radio_join")!({ name: "alpha" });
    expect(text(res)).toContain("[client hub-1.7.0+deadbee]");
  });

  it("forwards an explicit token as oldToken, and sends none when there is nothing to reclaim", async () => {
    const register = vi.fn(async (name: string) => ({ token: "t", name, reclaimed: false }));
    const a = makeFake();
    (a.deps.client as unknown as { register: unknown }).register = register;

    await a.tools.get("radio_join")!({ name: "alpha", token: "supplied-token" });
    expect(register).toHaveBeenCalledWith("alpha", "join-token", "supplied-token");

    const b = makeFake();
    (b.deps.client as unknown as { register: unknown }).register = register;
    await b.tools.get("radio_join")!({ name: "bravo" });
    // undefined, not null or "": HubClient only includes oldToken in the body when truthy.
    expect(register).toHaveBeenLastCalledWith("bravo", "join-token", undefined);
  });
});

describe("radio_send_image capability gating", () => {
  it("reads the local file when the transport can, exactly as before", async () => {
    const readLocalFile = vi.fn(() => Buffer.from("PNGDATA"));
    const a = makeFake({ readLocalFile });
    await a.tools.get("radio_join")!({ name: "alpha" });
    const res = await a.tools.get("radio_send_image")!({ to: "@all", source: "/tmp/pic.png" });
    expect(readLocalFile).toHaveBeenCalledWith("/tmp/pic.png");
    expect(text(res)).toContain("Image sent to @all");
  });

  it("refuses a local path without any file access when the radio is remote", async () => {
    const a = makeFake({ readLocalFile: undefined });
    await a.tools.get("radio_join")!({ name: "alpha" });
    const res = await a.tools.get("radio_send_image")!({ to: "@all", source: "/secrets/config.json" });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe(
      "This station is connected to a remote radio, so it cannot read files from your disk. " +
        "Read the file yourself and pass it to radio_over as image_data + image_mime_type, or " +
        "supply an http(s) URL if your hub allows it.",
    );
    // Nothing was sent, so nothing was exfiltrated.
    expect(a.client.sent).toHaveLength(0);
  });

  it("refuses an http(s) source without issuing a request when remote fetch is off", async () => {
    const fetchRemoteUrl = vi.fn(async () => Buffer.from("x"));
    const a = makeFake({ fetchRemoteUrl: undefined });
    await a.tools.get("radio_join")!({ name: "alpha" });
    const res = await a.tools.get("radio_send_image")!({
      to: "@all",
      source: "http://169.254.169.254/computeMetadata/v1/",
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("does not fetch remote URLs");
    expect(fetchRemoteUrl).not.toHaveBeenCalled();
    expect(a.client.sent).toHaveLength(0);
  });

  it("stays registered on every transport, so the tool list never depends on the transport", () => {
    const local = makeFake();
    const remote = makeFake({ readLocalFile: undefined, fetchRemoteUrl: undefined, waitScriptPath: undefined });
    expect([...local.tools.keys()].sort()).toEqual([...remote.tools.keys()].sort());
    expect(local.tools.has("radio_send_image")).toBe(true);
    expect(remote.tools.has("radio_send_image")).toBe(true);
  });
});

describe("radio_token", () => {
  let payload: (deps: Partial<RadioDeps>) => Promise<Record<string, unknown>>;
  beforeEach(() => {
    payload = async (overrides) => {
      const a = makeFake(overrides);
      await a.tools.get("radio_join")!({ name: "alpha" });
      return JSON.parse(text(await a.tools.get("radio_token")!({}))) as Record<string, unknown>;
    };
  });

  it("keeps the local 'no script installed' note when the radio is local", async () => {
    const p = await payload({ waitScriptPath: () => null });
    expect(p.waitScript).toBeNull();
    expect(p.waitScriptNote).toBe(
      "No shell listener is installed on this station. Use radio_standby instead; wait_seconds sets how long it blocks.",
    );
  });

  it("reports the path and its host requirement when a script is installed", async () => {
    const p = await payload({ waitScriptPath: () => "/opt/radio/bin/radio-wait.sh" });
    expect(p.waitScript).toBe("/opt/radio/bin/radio-wait.sh");
    expect(String(p.waitScriptNote)).toContain("starts a turn when a background task exits");
  });

  it("says the radio is hub-hosted rather than claiming the station has no script", async () => {
    const p = await payload({ waitScriptPath: undefined });
    expect(p.waitScript).toBeNull();
    expect(String(p.waitScriptNote)).toContain("hosted by the hub");
    // The token is still returned on purpose: it is what lets a listener process talk HTTP to
    // /poll directly while the agent's own MCP session stays remote.
    expect(p.token).toBeTruthy();
    expect(p.hubUrl).toBe("http://hub.test:9559");
  });
});

describe("radio_standby", () => {
  it("passes the request's abort signal through to the hub client", async () => {
    const poll = vi.fn(async () => null);
    const a = makeFake();
    (a.deps.client as unknown as { poll: unknown }).poll = poll;
    await a.tools.get("radio_join")!({ name: "alpha" });

    const ac = new AbortController();
    const res = await a.tools.get("radio_standby")!({ wait_seconds: 5 }, { signal: ac.signal });
    expect(poll).toHaveBeenCalledWith(a.deps.session.token, 5000, ac.signal);
    expect(text(res)).toBe("No new messages (poll timed out). Try again.");
  });

  it("clears the session and the stored token when the hub says the registration expired", async () => {
    const clear = vi.fn();
    const a = makeFake({ tokenStore: { read: () => null, write: () => {}, clear } });
    (a.deps.client as unknown as { poll: unknown }).poll = async () => {
      throw new Error("Unauthorized");
    };
    await a.tools.get("radio_join")!({ name: "alpha" });
    const res = await a.tools.get("radio_standby")!({});
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Registration expired");
    expect(a.deps.session.token).toBeNull();
    expect(clear).toHaveBeenCalledWith("http://hub.test:9559", "alpha");
  });

  it("clears the session on RADIO_KILLED and emits the stop instruction verbatim", async () => {
    const a = makeFake();
    (a.deps.client as unknown as { poll: unknown }).poll = async () => ({
      messages: [
        {
          id: "1",
          from: "system",
          to: "alpha",
          content: "RADIO_KILLED: You have been disconnected by the operator.",
          channel: "#all",
          timestamp: Date.now(),
        },
      ],
    });
    await a.tools.get("radio_join")!({ name: "alpha" });
    const res = await a.tools.get("radio_standby")!({});
    expect(text(res)).toBe(
      "RADIO_KILLED: You have been disconnected by the operator. Do NOT call any more radio tools. Stop immediately.",
    );
    expect(a.deps.session.token).toBeNull();
    expect(a.deps.session.name).toBeNull();
  });

  it("keeps the channel reminder's spacing distinct from radio_check's", async () => {
    const messages: RadioMessage[] = [
      { id: "1", from: "bravo", to: "alpha", content: "hi", channel: "#infra", timestamp: 0 },
    ];
    const a = makeFake();
    (a.deps.client as unknown as { poll: unknown }).poll = async () => ({ messages });
    (a.deps.client as unknown as { inbox: unknown }).inbox = async () => ({ messages });
    await a.tools.get("radio_join")!({ name: "alpha" });

    const standby = await a.tools.get("radio_standby")!({});
    const check = await a.tools.get("radio_check")!({});
    const hint = (r: ToolResult) => r.content[r.content.length - 1].text ?? "";
    expect(hint(standby).startsWith("\n\nIMPORTANT:")).toBe(true);
    expect(hint(check).startsWith("\nIMPORTANT:")).toBe(true);
    expect(hint(standby)).toContain('"#infra"');
  });
});
