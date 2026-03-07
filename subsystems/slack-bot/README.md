# Slack Bot for Walkie-Talkie

A Slack bot that bridges Slack and the Walkie-Talkie Hub. Users can mention the bot in Slack to send messages to AI agents connected to the Hub.

```
Slack (@walkie-talkie @alice do something)
  ↓
slack-bot (Socket Mode) ──HTTP──> Hub ──> Claude Code (alice)
  ↑                                           │
  └──── reply in thread ◄─────────────────────┘
```

## Setup

> See also: [Socket Mode guide on Slack docs](https://docs.slack.dev/tools/java-slack-sdk/guides/socket-mode/)

### 1. Create a Slack App

1. Go to [Slack API: Your Apps](https://api.slack.com/apps) and click **Create New App** → **From scratch**
2. Name it (e.g. `walkie-talkie`) and select your workspace

### 2. Enable Socket Mode

Socket Mode lets the bot connect to Slack via WebSocket — no public URL or server required.

1. Go to **Settings** → **Socket Mode**
2. Toggle **Enable Socket Mode** on

### 3. Generate an App-Level Token

1. Go to **Settings** → **Basic Information**
2. Scroll to **App-Level Tokens** and click **Generate Token and Scopes**
3. Name it (e.g. `socket-token`) and add the `connections:write` scope
4. Click **Generate**
5. Copy the token (starts with `xapp-`) — this is your `WALKIE_TALKIE_SLACK_APP_TOKEN`

### 4. Configure Bot Permissions

Go to **Features** → **OAuth & Permissions** and add these **Bot Token Scopes**:

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | Receive `@walkie-talkie` mentions |
| `channels:history` | Receive thread replies in public channels |
| `chat:write` | Post replies in threads |

### 5. Enable Event Subscriptions

With Socket Mode enabled, no Request URL is needed — events are delivered via WebSocket.

1. Go to **Features** → **Event Subscriptions** and toggle **on**
2. Under **Subscribe to bot events**, add these events:
   - `app_mention` — receive `@bot` mentions
   - `message.channels` — receive thread replies in public channels
3. Click **Save Changes**

### 6. Install to Workspace

1. Go to **Settings** → **Install App** and click **Install to Workspace**
2. Authorize the requested permissions
3. Copy the **Bot User OAuth Token** (starts with `xoxb-`) — this is your `WALKIE_TALKIE_SLACK_BOT_TOKEN`

### 7. Set Environment Variables

Add to your shell profile (e.g. `~/.zshrc`):

```bash
export WALKIE_TALKIE_SLACK_BOT_TOKEN=xoxb-your-bot-token
export WALKIE_TALKIE_SLACK_APP_TOKEN=xapp-your-app-token
export WALKIE_TALKIE_JOIN_TOKEN=your-hub-join-token
# Optional: override Hub URL (default: http://localhost:9559)
# export WALKIE_TALKIE_HUB_URL=http://localhost:9559
# Optional: Slack channel ID for system notifications (agent join/leave)
# The bot must be invited to this channel (/invite @walkie-talkie)
# export WALKIE_TALKIE_SLACK_SYSTEM_NOTIFY_CHANNEL=C0123456789
```

### 8. Build and Run

```bash
# From the project root
npm install
npm run build --workspace=@walkie-talkie/slack-bot
npm run start --workspace=@walkie-talkie/slack-bot
```

You should see:

```
[hub] Registered as "slack"
[slack-bot] Running
```

The bot also appears on the Hub dashboard as `slack`.

## Usage

In any Slack channel where the bot is invited:

```
@walkie-talkie @alice Please review the PR       → sends to agent "alice"
@walkie-talkie What is the project status?        → sends to @all (all connected agents)
```

The bot will:

1. Reply with `_thinking... (sending to ${to})_` in a thread
2. Forward the message to the Hub
3. Post the agent's response in the same thread

You can continue the conversation by replying in the same thread — no need to `@mention` the bot again. To specify a different agent in the thread, use `@alice message`.

## Troubleshooting

### Bot doesn't respond to mentions

- Make sure the bot is **invited to the channel** (`/invite @walkie-talkie`)
- Check that `app_mention` and `message.channels` are subscribed under Event Subscriptions
- Verify Socket Mode is enabled
- If you changed Event Subscriptions after initial install, **Reinstall the app** (**Settings** → **Install App** → **Reinstall to Workspace**)

### "Failed to register on Hub" error

- Make sure the Hub is running (`npm start` from the project root)
- Verify `WALKIE_TALKIE_JOIN_TOKEN` matches the Hub's token

### Agent reply never comes

- Confirm the target agent is connected to the Hub (check the dashboard)
- The bot waits via long-polling; if the agent takes too long, check the agent's status
