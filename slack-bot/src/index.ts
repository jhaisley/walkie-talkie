import bolt from "@slack/bolt";

const { App } = bolt;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const HUB_URL = process.env.WALKIE_TALKIE_HUB_URL || "http://localhost:9559";
const JOIN_TOKEN = process.env.WALKIE_TALKIE_JOIN_TOKEN;
const BOT_NAME = "slack";

if (!SLACK_BOT_TOKEN) {
  console.error("SLACK_BOT_TOKEN environment variable is required");
  process.exit(1);
}
if (!SLACK_APP_TOKEN) {
  console.error("SLACK_APP_TOKEN environment variable is required");
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

async function hubRegister(): Promise<void> {
  const res = await fetch(`${HUB_URL}/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${JOIN_TOKEN}`,
    },
    body: JSON.stringify({ name: BOT_NAME }),
  });
  if (!res.ok) {
    const err = (await res.json()) as { error: string };
    throw new Error(`Failed to register on Hub: ${err.error}`);
  }
  const data = (await res.json()) as { token: string; name: string };
  hubToken = data.token;
  console.log(`[hub] Registered as "${data.name}"`);
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

// ---------------------------------------------------------------------------
// Poll loop — receives messages from Hub and posts to Slack
// ---------------------------------------------------------------------------

let slackApp: InstanceType<typeof App>;

async function pollLoop(): Promise<void> {
  while (true) {
    try {
      const messages = await hubPoll();
      for (const msg of messages) {
        // Skip system messages
        if (msg.from === "system") continue;
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
            text: `*${msg.from}*:\n${msg.content}`,
          });
        } else {
          // No pending reply — post as a new message to a default channel if configured
          console.log(`[hub] Unmatched message from ${msg.from}: ${msg.content.slice(0, 100)}`);
        }
      }
    } catch (e) {
      console.error("[poll] Error:", (e as Error).message);
      // Wait before retrying on error
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

// ---------------------------------------------------------------------------
// Parse mention text: "@wt @alice do something" or "@wt do something"
// ---------------------------------------------------------------------------

function parseCommand(text: string): { to: string; content: string } {
  const trimmed = text.trim();

  // Check if the first word is @someone
  const match = trimmed.match(/^@(\S+)\s+([\s\S]*)$/);
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

  // Handle mentions: @wt <message>
  slackApp.event("app_mention", async ({ event, say }) => {
    // Remove the bot mention from the text (e.g., "<@U12345> @alice do something" -> "@alice do something")
    const rawText = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();

    if (!rawText) {
      await say({ text: "Usage: `@wt @agent-name message` or `@wt message`", thread_ts: event.ts });
      return;
    }

    const { to, content } = parseCommand(rawText);

    // Post "thinking..." in thread
    const thinkingRes = await say({ text: `_thinking... (sending to ${to})_`, thread_ts: event.ts });

    // Track pending reply
    const agentKey = to === "@all" ? "*" : to.slice(1);
    pendingReplies.set(agentKey, {
      slackChannel: event.channel,
      threadTs: event.ts,
    });

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

  // Register on Hub
  await hubRegister();

  // Start poll loop
  pollLoop();

  // Start Slack app
  await slackApp.start();
  console.log("[slack-bot] Running");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
