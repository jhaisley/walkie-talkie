import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatConnectedUsers } from "./helpers.js";
import { createLocalDeps } from "./local-deps.js";
import type { RadioDeps, RadioMessage } from "./radio-deps.js";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function getMimeType(source: string): string {
  const ext = path.extname(source).toLowerCase();
  return MIME_TYPES[ext] ?? "image/png";
}

/** The guard every tool but radio_join and radio_out shares. Wording is a contract: stations
 * (and their operators) match on it, so it must read identically on both transports. */
const NOT_ON_AIR = "Not on the air. Use radio_join first.";

type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Render a batch of delivered messages the way radio_check and radio_standby both do. */
function renderMessages(messages: RadioMessage[], separator: string): ContentBlock[] {
  const contentBlocks: ContentBlock[] = [];
  for (const m of messages) {
    if (m.image) {
      contentBlocks.push({ type: "image" as const, data: m.image.data, mimeType: m.image.mimeType });
    }
    const imageTag = m.image ? " [image attached]" : "";
    const line = `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.channel || "#all"} ${m.from} → ${m.to}: ${m.content}${imageTag}`;
    contentBlocks.push({ type: "text" as const, text: line });
  }
  const channels = [...new Set(messages.filter((m) => m.channel && m.channel !== "#all").map((m) => m.channel))];
  if (channels.length > 0) {
    contentBlocks.push({
      type: "text" as const,
      text: `${separator}IMPORTANT: Reply in the same channel you received the message on. Use the channel parameter: ${channels
        .map((c) => `"${c}"`)
        .join(", ")}`,
    });
  }
  return contentBlocks;
}

const KILLED_TEXT =
  "RADIO_KILLED: You have been disconnected by the operator. Do NOT call any more radio tools. Stop immediately.";

/**
 * Register the twelve radio tools on `server`, closing over `deps`.
 *
 * Called once per McpServer instance. It has to be once per instance rather than once per
 * process because `Protocol.connect()` refuses a second transport ("Already connected to a
 * transport… or use a separate Protocol instance per connection"), so a hub serving many
 * stations necessarily builds one McpServer per session — and each of those needs its own
 * `deps.session`, or two stations share a callsign and a token.
 */
export function registerRadioTools(server: McpServer, deps: RadioDeps): void {
  const { client, session } = deps;

  server.tool(
    "radio_join",
    "Join the Walkie-Talkie hub with a display name. You must join before using other radio tools.",
    {
      name: z.string().describe("Your display name for this session"),
      token: z
        .string()
        .optional()
        .describe(
          "A session token previously issued for this callsign (see radio_token). Supply it to reclaim a registration this station still holds — required when the radio is hosted remotely, which has no local token store to reclaim from.",
        ),
    },
    async ({ name, token }) => {
      // Reclaim path: prefer an explicitly supplied token, then the live one, then the one
      // persisted by a previous process. The hub lets the proven owner take its own
      // registration back, so a restarted station recovers its callsign immediately instead
      // of waiting to be reaped out of it.
      const priorToken = token ?? session.token ?? deps.tokenStore.read(client.getBaseUrl(), name) ?? undefined;
      try {
        const result = await client.register(name, deps.joinToken, priorToken);
        session.token = result.token;
        session.name = result.name;
        deps.tokenStore.write(client.getBaseUrl(), result.name, result.token);
        // The hub tells us; do not re-derive it from the tokens (see handleRegister).
        const reclaimed = result.reclaimed === true;
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Registered as "${session.name}". You are now in #all. You can now send and receive messages.` +
                // Stable markers, in this order, for operators and fleet tooling reading the
                // pane: whether a held name was taken back, and which bundle this station runs.
                // Treated as a contract — see the client-build note in README.
                (reclaimed ? " (Reclaimed a previous registration for this callsign.)" : "") +
                ` [client ${deps.clientBuildLabel}]`,
            },
          ],
        };
      } catch (e) {
        const msg = (e as Error).message;
        // A held name we could not prove ownership of means our stored token is no longer the
        // one the hub has. Drop it so the next attempt is a clean first-time join rather than
        // a retry with a credential we now know is wrong.
        if (msg.includes("already registered")) deps.tokenStore.clear(client.getBaseUrl(), name);
        return {
          content: [{ type: "text" as const, text: `Registration failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "radio_over",
    "Send a message to another user. Use @name format for the recipient, or @all to broadcast. Messages are scoped to a channel.",
    {
      to: z.string().describe("Recipient: @name or @all"),
      message: z.string().describe("Message content"),
      channel: z
        .string()
        .optional()
        .describe(
          "Channel to send to. IMPORTANT: Always reply in the same channel where you received the message. Defaults to #all if omitted.",
        ),
      image_data: z
        .string()
        .optional()
        .describe("Base64-encoded image data. Must be provided together with image_mime_type."),
      image_mime_type: z
        .string()
        .optional()
        .describe("MIME type of the image (e.g. 'image/png'). Must be provided together with image_data."),
    },
    async ({ to, message, channel, image_data, image_mime_type }) => {
      if (!session.token) {
        return {
          content: [{ type: "text" as const, text: NOT_ON_AIR }],
          isError: true,
        };
      }
      try {
        const image = image_data && image_mime_type ? { data: image_data, mimeType: image_mime_type } : undefined;
        const result = await client.send(session.token, to, message, channel, image);
        return {
          content: [
            {
              type: "text" as const,
              // Report who it actually reached. A send that reached NOBODY is otherwise
              // indistinguishable from one that reached the room — both a 200 with an id — and
              // that silence has already cost this fleet ~35 minutes once, when a station talked
              // to a mistyped channel. `recipients` is absent on hubs older than this field, so
              // the qualifier simply does not appear rather than claiming zero.
              text:
                `Message sent to ${result.to} in ${channel || "#all"} (id: ${result.id})` +
                (result.recipients === 0
                  ? " — WARNING: delivered to 0 recipients. Nobody is currently in that channel; check radio_channels."
                  : typeof result.recipients === "number"
                    ? ` — ${result.recipients} recipient(s)`
                    : "") +
                (result.offline
                  ? " — NOTE: that station is registered but offline; it will see this when it returns."
                  : ""),
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Send failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // The tool is registered on BOTH transports with the same name and schema, deliberately.
  // Omitting it on the hub would make the tool list depend on which transport a station happens
  // to be on, which is exactly the version-skew confusion the remote transport exists to delete.
  // Only the description and the capability gates below differ.
  const sendImageDescription = deps.readLocalFile
    ? "Send an image from a local file path or URL. Much faster than passing base64 via radio_over."
    : deps.fetchRemoteUrl
      ? "Send an image from an http(s) URL. Local file paths are NOT available: this station's radio is hosted by the hub, so a path would name the hub's disk, not yours. For a local file, read it yourself and pass it to radio_over as image_data + image_mime_type."
      : "Send an image. This station's radio is hosted by the hub, which reads neither your disk nor remote URLs, so both source forms are unavailable here: read the file yourself and pass it to radio_over as image_data + image_mime_type.";

  server.tool(
    "radio_send_image",
    sendImageDescription,
    {
      to: z.string().describe("Recipient: @name or @all"),
      source: z.string().describe("Image file path or URL (http/https)"),
      message: z.string().optional().describe("Optional text message to accompany the image"),
      channel: z.string().optional().describe("Channel to send to (default: #all)"),
    },
    async ({ to, source, message, channel }) => {
      if (!session.token) {
        return {
          content: [{ type: "text" as const, text: NOT_ON_AIR }],
          isError: true,
        };
      }
      const isUrl = source.startsWith("http://") || source.startsWith("https://");
      // Gate BEFORE any I/O. On the hub a local path would be an arbitrary file read on the
      // container host by any holder of the shared join token (/secrets/config.json is a
      // Salesforce + AlloyDB credential set), and a URL would be a request forger with reach
      // to the GCP metadata server and every internal service.
      if (isUrl && !deps.fetchRemoteUrl) {
        return {
          content: [
            {
              type: "text" as const,
              text: "This radio does not fetch remote URLs. Download the image yourself and pass it to radio_over as image_data + image_mime_type.",
            },
          ],
          isError: true,
        };
      }
      if (!isUrl && !deps.readLocalFile) {
        return {
          content: [
            {
              type: "text" as const,
              text: "This station is connected to a remote radio, so it cannot read files from your disk. Read the file yourself and pass it to radio_over as image_data + image_mime_type, or supply an http(s) URL if your hub allows it.",
            },
          ],
          isError: true,
        };
      }
      try {
        const buf = isUrl ? await deps.fetchRemoteUrl!(source) : deps.readLocalFile!(source);
        const data = buf.toString("base64");
        const mimeType = getMimeType(source);
        const result = await client.send(session.token, to, message ?? "", channel, { data, mimeType });
        return {
          content: [
            {
              type: "text" as const,
              text: `Image sent to ${result.to} in ${channel || "#all"} (id: ${result.id})`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed to send image: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "radio_check",
    "Check for new messages immediately without waiting. Returns any queued messages instantly. Use this instead of radio_standby when you want to poll periodically with sleep in between.",
    {},
    async () => {
      if (!session.token) {
        return {
          content: [{ type: "text" as const, text: NOT_ON_AIR }],
          isError: true,
        };
      }
      try {
        const result = await client.inbox(session.token);
        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }
        const killed = result.messages.find((m) => m.content.startsWith("RADIO_KILLED:"));
        if (killed) {
          session.token = null;
          session.name = null;
          return {
            content: [{ type: "text" as const, text: KILLED_TEXT }],
            isError: true,
          };
        }
        return { content: renderMessages(result.messages, "\n") };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Check failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "radio_standby",
    "Stand by for incoming messages using long polling. Returns as soon as a message arrives, or " +
      "empty when the wait window elapses. Optionally pass wait_seconds to choose the window: use a " +
      "long one (e.g. 1200 = 20 minutes) when you expect to be idle or are about to start long " +
      "running work, and a short one when you are mid-conversation and expect a prompt reply. A " +
      "longer window does NOT delay delivery — the hub answers the moment a message is routed — it " +
      "only reduces how often an empty return wakes you, which is the main cost of sitting idle. " +
      "Values above this install's configured ceiling are clamped rather than rejected.",
    { wait_seconds: z.number().positive().optional() },
    async ({ wait_seconds }, extra) => {
      if (!session.token) {
        return {
          content: [{ type: "text" as const, text: NOT_ON_AIR }],
          isError: true,
        };
      }
      try {
        const result = await client.poll(
          session.token,
          deps.clampStandbyMs(wait_seconds ? wait_seconds * 1000 : undefined),
          // Only the in-process (hub-hosted) client uses this: it stops waiting when the tool
          // call is cancelled. It must NOT be read as a dead station — a cancelled standby is
          // an agent changing its mind, and treating that as a crash is what reaped the fleet.
          extra?.signal,
        );
        if (!result || result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages (poll timed out). Try again." }],
          };
        }
        // Check for kill signal from operator
        const killed = result.messages.find((m) => m.content.startsWith("RADIO_KILLED:"));
        if (killed) {
          session.token = null;
          session.name = null;
          return {
            content: [{ type: "text" as const, text: KILLED_TEXT }],
            isError: true,
          };
        }
        return { content: renderMessages(result.messages, "\n\n") };
      } catch (e) {
        const msg = (e as Error).message;
        if (msg === "Unauthorized") {
          if (session.name) deps.tokenStore.clear(client.getBaseUrl(), session.name);
          session.token = null;
          session.name = null;
          return {
            content: [
              {
                type: "text" as const,
                text: "Registration expired — your token is no longer valid (stale timeout, kick, or hub restart). Call radio_join to resume; the hub restores the channels you had not explicitly left.",
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Poll failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "radio_channels",
    "List all currently connected users on the hub and available channels.",
    {},
    async () => {
      if (!session.token) {
        return {
          content: [{ type: "text" as const, text: NOT_ON_AIR }],
          isError: true,
        };
      }
      try {
        const [users, channels] = await Promise.all([client.users(session.token), client.listChannels(session.token)]);
        const userText = formatConnectedUsers(users);
        const channelText =
          channels.length > 0
            ? `Channels: ${channels.map((c) => `${c.name} (${c.memberCount} members)`).join(", ")}`
            : "No channels.";
        return {
          content: [
            {
              type: "text" as const,
              text: `${userText}\n${channelText}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "radio_channel_create",
    "Create a new channel on the hub. You will automatically join the channel.",
    { name: z.string().describe("Channel name (with or without # prefix)") },
    async ({ name }) => {
      if (!session.token) {
        return {
          content: [{ type: "text" as const, text: NOT_ON_AIR }],
          isError: true,
        };
      }
      try {
        const result = await client.createChannel(session.token, name);
        return {
          content: [
            {
              type: "text" as const,
              text: `Channel ${result.channel} created. You have been auto-joined.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed to create channel: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "radio_channel_join",
    "Join an existing channel to send and receive messages in it.",
    { channel: z.string().describe("Channel name to join (e.g. #my-channel)") },
    async ({ channel }) => {
      if (!session.token) {
        return {
          content: [{ type: "text" as const, text: NOT_ON_AIR }],
          isError: true,
        };
      }
      try {
        await client.joinChannel(session.token, channel);
        return {
          content: [
            {
              type: "text" as const,
              text: `Joined ${channel}.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed to join channel: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "radio_channel_leave",
    "Leave a channel. You cannot leave #all.",
    { channel: z.string().describe("Channel name to leave") },
    async ({ channel }) => {
      if (!session.token) {
        return {
          content: [{ type: "text" as const, text: NOT_ON_AIR }],
          isError: true,
        };
      }
      try {
        await client.leaveChannel(session.token, channel);
        return {
          content: [
            {
              type: "text" as const,
              text: `Left ${channel}.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed to leave channel: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "radio_channel_invite",
    "Invite another user to a channel. The user is automatically joined and notified via their next poll.",
    {
      channel: z.string().describe("Channel name to invite the user to"),
      user: z.string().describe("User to invite (e.g. @agent-name)"),
    },
    async ({ channel, user }) => {
      if (!session.token) {
        return {
          content: [{ type: "text" as const, text: NOT_ON_AIR }],
          isError: true,
        };
      }
      try {
        await client.inviteToChannel(session.token, channel, user);
        return {
          content: [
            {
              type: "text" as const,
              text: `Invited ${user} to ${channel}.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed to invite: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "radio_token",
    "Get the current session token and hub URL, plus the path to the shell listener script if " +
      "this station has one installed. The token and hubUrl are all a listener actually needs — " +
      "it is an HTTP client, not an MCP one. waitScript is null when no script is installed, " +
      "which is the normal case: no installer currently ships one. The listener design also " +
      "requires a host that wakes the agent when a background task completes; on a strictly " +
      "turn-based CLI it would detect a message with no way to report it.",
    {},
    async () => {
      if (!session.token) {
        return {
          content: [{ type: "text" as const, text: NOT_ON_AIR }],
          isError: true,
        };
      }
      // A remote radio has no station-side script to point at, and probing the hub's own disk
      // would answer a question nobody asked. Say which it is rather than emitting the local
      // "not installed on this station" note from a machine that is not the station.
      const local = deps.waitScriptPath !== undefined;
      const waitScript = local ? deps.waitScriptPath!() : null;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              hubUrl: client.getBaseUrl(),
              clientBuild: deps.clientBuildLabel,
              // Deliberately returned to remote stations too: it is what lets a listener
              // process (Python, so a Windows station can run it) talk HTTP to /poll directly
              // while the agent's own MCP session stays remote.
              token: session.token,
              waitScript,
              // Stated rather than left to be inferred from a bare null. A station reading null
              // should stop looking for the file; one reading a path should know the mechanism
              // has a host requirement beyond the file existing.
              waitScriptNote: !local
                ? "This station's radio is hosted by the hub, so there is no locally-installed listener script. The hubUrl and token above are all a listener needs; the shell script ships only with a locally-installed radio. Otherwise use radio_standby; wait_seconds sets how long it blocks."
                : waitScript === null
                  ? "No shell listener is installed on this station. Use radio_standby instead; wait_seconds sets how long it blocks."
                  : "Run this with the hubUrl and token above. Requires a host that starts a turn when a background task exits; a strictly turn-based CLI cannot be woken this way.",
            }),
          },
        ],
      };
    },
  );

  server.tool("radio_out", "Sign off and disconnect from the Walkie-Talkie hub. Over and out.", {}, async () => {
    if (!session.token) {
      return {
        content: [{ type: "text" as const, text: "Not registered." }],
      };
    }
    try {
      await client.unregister(session.token);
      const name = session.name;
      // A deliberate sign-off ends the claim: keeping the token would let a later process
      // silently take a callsign the operator intended to release.
      if (name) deps.tokenStore.clear(client.getBaseUrl(), name);
      session.token = null;
      session.name = null;
      return {
        content: [{ type: "text" as const, text: `Unregistered "${name}". Disconnected from hub.` }],
      };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `Unregister failed: ${(e as Error).message}` }],
        isError: true,
      };
    }
  });
}

/**
 * The stdio entry point, unchanged in signature and in every string it emits.
 *
 * Kept so mcp-server/src/index.ts and the plugin bundle need no edit at all: the deps refactor
 * has to be invisible to installed stations, which is the only way to land it without a fleet
 * reinstall.
 */
export function createMcpServer(
  hubUrl: string,
  joinTok: string,
  credKind: "join-token" | "station-key" = "join-token",
): McpServer {
  const server = new McpServer({
    name: "walkie-talkie",
    version: "1.0.0",
  });
  registerRadioTools(server, createLocalDeps(hubUrl, joinTok, credKind));
  return server;
}
