import bolt from "@slack/bolt";

const { App } = bolt;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SLACK_BOT_TOKEN = process.env.WALKIE_TALKIE_SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.WALKIE_TALKIE_SLACK_APP_TOKEN;
const HUB_URL = process.env.WALKIE_TALKIE_HUB_URL || "http://localhost:9559";
const JOIN_TOKEN = process.env.WALKIE_TALKIE_JOIN_TOKEN;
let slackNotifyChannel: string | null = process.env.WALKIE_TALKIE_SLACK_SYSTEM_NOTIFY_CHANNEL ?? null;
const BOT_NAME = "slack";

if (!SLACK_BOT_TOKEN) {
  console.error("WALKIE_TALKIE_SLACK_BOT_TOKEN environment variable is required");
  process.exit(1);
}
if (!SLACK_APP_TOKEN) {
  console.error("WALKIE_TALKIE_SLACK_APP_TOKEN environment variable is required");
  process.exit(1);
}
if (!JOIN_TOKEN) {
  console.error("WALKIE_TALKIE_JOIN_TOKEN environment variable is required");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Hub client
// ---------------------------------------------------------------------------

let hubToken: string | null = null;
let botUserId: string | null = null;

async function hubRegister(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${HUB_URL}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${JOIN_TOKEN}`,
      },
      body: JSON.stringify({ name: BOT_NAME, oldToken: hubToken, role: "bridge" }),
    });
    if (res.ok) {
      const data = (await res.json()) as { token: string; name: string };
      hubToken = data.token;
      console.log(`[hub] Registered as "${data.name}"`);
      return;
    }
    const err = (await res.json()) as { error: string };
    if (res.status === 409 && attempt < 2) {
      console.log("[hub] Already registered, waiting for grace period to expire...");
      await new Promise((resolve) => setTimeout(resolve, 35_000));
      continue;
    }
    throw new Error(`Failed to register on Hub: ${err.error}`);
  }
}

async function hubSend(to: string, content: string): Promise<void> {
  const res = await fetch(`${HUB_URL}/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${hubToken}`,
    },
    body: JSON.stringify({ to, content }),
  });
  if (!res.ok) {
    const err = (await res.json()) as { error: string };
    throw new Error(`Failed to send message: ${err.error}`);
  }
}

interface HubMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  channel: string;
  timestamp: number;
}

interface HubUser {
  name: string;
  online: boolean;
  role: string;
}

async function hubGetAgents(): Promise<HubUser[]> {
  const res = await fetch(`${HUB_URL}/users`);
  if (!res.ok) return [];
  const data = (await res.json()) as { users: HubUser[] };
  return data.users.filter((u) => u.role === "agent" && u.online);
}

async function hubPoll(): Promise<HubMessage[]> {
  const res = await fetch(`${HUB_URL}/poll`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${hubToken}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Poll failed: ${res.status}`);
  }
  const data = (await res.json()) as { messages: HubMessage[] };
  return data.messages;
}

// ---------------------------------------------------------------------------
// Pending reply tracking
// ---------------------------------------------------------------------------

interface PendingReply {
  slackChannel: string;
  threadTs: string;
}

// Map: agent name -> pending reply info
// When we send to @all, we use "*" as the key
const pendingReplies = new Map<string, PendingReply>();

// Map: Slack thread_ts -> last agent name used in that thread
const threadAgents = new Map<string, string>();

// ---------------------------------------------------------------------------
// System message formatting
// ---------------------------------------------------------------------------

function formatSystemMessage(content: string): string | null {
  if (content.startsWith("CONNECTED_USERS: ")) {
    const users = content.slice("CONNECTED_USERS: ".length);
    if (users === "(none)") {
      return ":satellite: Walkie-Talkie bridge connected. No agents online.";
    }
    return `:satellite: Walkie-Talkie bridge connected. Online agents: ${users}`;
  }
  if (content.startsWith("USER_JOINED: ")) {
    const name = content.slice("USER_JOINED: ".length);
    return `:loud_sound: *${name}* joined Walkie-Talkie`;
  }
  if (content.startsWith("USER_LEFT: ")) {
    const name = content.slice("USER_LEFT: ".length);
    return `:mute: *${name}* left Walkie-Talkie`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Poll loop — receives messages from Hub and posts to Slack
// ---------------------------------------------------------------------------

let slackApp: InstanceType<typeof App>;

async function pollLoop(): Promise<void> {
  while (!shuttingDown) {
    try {
      const messages = await hubPoll();
      for (const msg of messages) {
        // Handle system notifications (user join/leave)
        if (msg.from === "system") {
          console.log(`[system] ${msg.content}`);
          if (msg.content.startsWith("RADIO_KILLED:")) {
            console.log("[slack-bot] Received RADIO_KILLED, stopping poll loop.");
            return;
          }
          if (slackNotifyChannel) {
            const text = formatSystemMessage(msg.content);
            if (text) {
              try {
                await slackApp.client.chat.postMessage({ channel: slackNotifyChannel, text });
              } catch (e) {
                const err = (e as Error).message;
                console.error(
                  `[notify] Failed to post to ${slackNotifyChannel}: ${err}. Disabling Slack notifications.`,
                );
                slackNotifyChannel = null;
              }
            }
          }
          continue;
        }
        // Skip our own messages
        if (msg.from === BOT_NAME) continue;

        // Find the pending reply for this agent or for @all
        const pending = pendingReplies.get(msg.from) || pendingReplies.get("*");
        if (pending) {
          pendingReplies.delete(msg.from);
          pendingReplies.delete("*");

          await slackApp.client.chat.postMessage({
            channel: pending.slackChannel,
            thread_ts: pending.threadTs,
            text: `*@@${msg.from}*:\n${msg.content}`,
          });
        } else {
          // No pending reply — post as a new message to a default channel if configured
          console.log(`[hub] Unmatched message from ${msg.from}: ${msg.content.slice(0, 100)}`);
        }
      }
    } catch (e) {
      console.error("[poll] Error:", (e as Error).message);
      // Re-register and retry
      try {
        await hubRegister();
      } catch (regErr) {
        console.error("[poll] Re-register failed:", (regErr as Error).message);
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

// ---------------------------------------------------------------------------
// Slack mention handling
// ---------------------------------------------------------------------------

function stripBotMention(text: string): string {
  // Remove only the bot's own mention, keep all other <@USER> mentions intact
  if (botUserId) {
    return text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
  }
  return text;
}

// ---------------------------------------------------------------------------
// Parse mention text: "@walkie-talkie @@alice do something" or "@walkie-talkie do something"
// ---------------------------------------------------------------------------

function parseCommand(text: string): { to: string; content: string } {
  const trimmed = text.trim();

  // Check if the first token is @@someone (double-@ to avoid Slack mention confusion)
  const match = trimmed.match(/^@@(\S+)\s+([\s\S]*)$/);
  if (match) {
    return { to: `@${match[1]}`, content: match[2].trim() };
  }

  // No target specified — send to @all
  return { to: "@all", content: trimmed };
}

// ---------------------------------------------------------------------------
// Slack app
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  slackApp = new App({
    token: SLACK_BOT_TOKEN,
    appToken: SLACK_APP_TOKEN,
    socketMode: true,
  });

  // Handle mentions: @walkie-talkie <message>
  slackApp.event("app_mention", async ({ event, say }) => {
    const rawText = stripBotMention(event.text);

    if (!rawText) {
      await say({
        text: "Usage: `@walkie-talkie @@agent-name message` or `@walkie-talkie message`",
        thread_ts: event.ts,
      });
      return;
    }

    const { to, content } = parseCommand(rawText);

    // Check if any agents are connected
    const agents = await hubGetAgents();
    if (agents.length === 0) {
      await say({ text: "No agents are currently connected to the Hub.", thread_ts: event.ts });
      return;
    }

    // Post "thinking..." in thread
    const thinkingRes = await say({ text: `_thinking... (sending to ${to})_`, thread_ts: event.ts });

    // Track pending reply and remember agent for this thread
    const agentKey = to === "@all" ? "*" : to.slice(1);
    pendingReplies.set(agentKey, {
      slackChannel: event.channel,
      threadTs: event.ts,
    });
    if (to !== "@all") {
      threadAgents.set(event.ts, to);
    }

    // Send to Hub
    try {
      await hubSend(to, `[from Slack] ${content}`);
      console.log(`[slack] ${to}: ${content.slice(0, 100)}`);
    } catch (e) {
      const errorMsg = (e as Error).message;
      // Update the thinking message with the error
      if (thinkingRes?.ts) {
        await slackApp.client.chat.update({
          channel: event.channel,
          ts: thinkingRes.ts,
          text: `Error: ${errorMsg}`,
        });
      }
      pendingReplies.delete(agentKey);
    }
  });

  // Handle thread replies (without @mention)
  slackApp.message(async ({ message, say }) => {
    const msg = message as unknown as Record<string, unknown>;
    // Only handle thread replies
    if (!msg.thread_ts) return;
    // Ignore bot's own messages
    if (msg.bot_id) return;

    const text = typeof msg.text === "string" ? msg.text : "";
    const rawText = stripBotMention(text);
    if (!rawText) return;

    const threadTs = msg.thread_ts as string;
    const channel = msg.channel as string;

    // If no target specified, use the last agent from this thread
    let { to, content } = parseCommand(rawText);
    if (to === "@all" && threadAgents.has(threadTs)) {
      to = threadAgents.get(threadTs)!;
      content = rawText;
    }

    // Check if any agents are connected
    const agents = await hubGetAgents();
    if (agents.length === 0) {
      await say({ text: "No agents are currently connected to the Hub.", thread_ts: threadTs });
      return;
    }

    // Track pending reply for the thread
    const agentKey = to === "@all" ? "*" : to.slice(1);
    if (to !== "@all") {
      threadAgents.set(threadTs, to);
    }
    pendingReplies.set(agentKey, {
      slackChannel: channel,
      threadTs,
    });

    try {
      await hubSend(to, `[from Slack] ${content}`);
      console.log(`[slack:thread] ${to}: ${content.slice(0, 100)}`);
    } catch (e) {
      await say({ text: `Error: ${(e as Error).message}`, thread_ts: threadTs });
      pendingReplies.delete(agentKey);
    }
  });

  // Get bot's own user ID
  const authResult = await slackApp.client.auth.test();
  botUserId = authResult.user_id ?? null;
  console.log(`[slack] Bot user ID: ${botUserId}`);

  // Register on Hub
  await hubRegister();

  // Start poll loop
  pollLoop();

  // Start Slack app
  await slackApp.start();
  console.log("[slack-bot] Running");
}

async function notifyShutdown(): Promise<void> {
  if (!slackNotifyChannel) return;
  try {
    await slackApp.client.chat.postMessage({
      channel: slackNotifyChannel,
      text: ":electric_plug: Walkie-Talkie bridge disconnected.",
    });
  } catch {
    // best effort
  }
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[slack-bot] Shutting down...");
  await notifyShutdown();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

main().catch((e) => {
  console.error("Fatal:", e);
  notifyShutdown().finally(() => process.exit(1));
});
