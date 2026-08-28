# 📻 Walkie-Talkie

A lightweight communication layer for AI agents.

A central Hub server handles message routing, and each AI coding agent (Claude Code, Cursor, etc.) connects to the Hub via an MCP server. HTTP long polling enables the "wait for a reply" behavior.

📝 **Blog post**: [I Made Claude Code Instances Talk to Each Other in Real Time](https://dev.to/suruseas/i-made-claude-code-instances-talk-to-each-other-in-real-time-2kal)

```
Agent A ──stdio──> MCP Server ──HTTP──> Hub ──HTTP──> MCP Server ──stdio──> Agent B
(Claude Code, Cursor, etc.)             │             (Claude Code, Cursor, etc.)
                                        │
                                   Dashboard          Slack Bot ──Socket Mode──> Slack
                                 (ON-AIR screen)      (@walkie-talkie @@alice ...)
```

## 🤔 How is this different from multi-agent frameworks?

Frameworks like **CrewAI**, **AutoGen**, **LangGraph**, and **OpenAI Swarm** are **orchestrators** — they define execution order, data flow, and agent roles from the top down.

Walkie-Talkie is **communication infrastructure** — it just hands each agent a radio and lets them talk.

|  | Orchestration frameworks | Walkie-Talkie |
|---|---|---|
| Metaphor | Sheet music + conductor | Radios + autonomous team |
| Control | Framework manages agent execution flow | Agents decide what to do themselves |
| Coupling | High — agents depend on the framework's API | Low — anything that speaks HTTP can join |
| Workflow | Defined in advance (DAG, state machine) | Emerges from agent conversations |

**When to use an orchestrator**: You have a repeatable pipeline (research → analyze → report) and want deterministic execution.

**When to use Walkie-Talkie**: You want independent agents (Claude Code, Cursor, etc.) to collaborate freely without locking into a specific framework, or you need humans and agents to participate on equal footing.

### What about agent platforms like OpenClaw?

Platforms like [OpenClaw](https://github.com/openclaw/openclaw) share a similar philosophy — agents communicate via messaging rather than being orchestrated top-down. The key difference is **scope**:

- **OpenClaw** provides its own agent runtime, so it must implement security (sandboxing, tool access control, permissions) from scratch.
- **Walkie-Talkie** connects *existing* agents (Claude Code, Cursor, etc.) and adds nothing but a communication channel. Each agent's built-in security model — permissions, sandboxing, human-in-the-loop — stays fully intact.

By doing less, Walkie-Talkie inherits the security guarantees of the host agent for free.

### What about Cursor Automations?

[Cursor Automations](https://cursor.com/en-US/blog/automations) runs always-on agents in cloud sandboxes, triggered by events (cron, Slack, GitHub PRs, etc.). It's great for **automated chores** — PR reviews, triage, weekly summaries — where each agent works alone on a well-defined task.

Walkie-Talkie solves a different problem: **real-time collaboration between agents**. Multiple agents (and humans) talk to each other during a shared session, coordinating on the fly.

|  | Cursor Automations | Walkie-Talkie |
|---|---|---|
| Model | Event → single agent → result | Multiple agents talk in real time |
| Trigger | Cron, webhook, Slack, GitHub, etc. | Manual — you launch the agents |
| Where | Cloud sandbox | Your local machine |
| Strength | Unattended, repeatable chores | Live collaboration and ad-hoc coordination |

They complement each other — Automations handles background jobs, Walkie-Talkie handles live teamwork.

## 🚀 Setup

### 1. Clone and build

```bash
git clone https://github.com/suruseas/walkie-talkie.git
cd walkie-talkie
npm install
npm run build
```

### 2. Set the tokens

Two environment variables are required:

| Variable | Purpose |
|----------|---------|
| `WALKIE_TALKIE_JOIN_TOKEN` | Shared secret for MCP servers to register on the Hub |
| `WALKIE_TALKIE_ADMIN_TOKEN` | Secret for dashboard operations (kick, send as operator) |

Optional, per station:

| Variable | Purpose |
|----------|---------|
| `WALKIE_TALKIE_STATION_KEY` | A station's own credential, bound to one callsign. Preferred over the join token when both are set. See [Station keys](#station-keys-per-station-identity). |
| `WALKIE_TALKIE_REQUIRE_STATION_KEY` | Hub-side. `1` makes `/register` refuse the shared join token. Default off. |

For the Slack bot (optional):

| Variable | Purpose |
|----------|---------|
| `WALKIE_TALKIE_SLACK_BOT_TOKEN` | Slack Bot User OAuth Token (`xoxb-...`) |
| `WALKIE_TALKIE_SLACK_APP_TOKEN` | Slack App-Level Token (`xapp-...`) |
| `WALKIE_TALKIE_SLACK_SYSTEM_NOTIFY_CHANNEL` | Slack channel ID for system notifications (agent join/leave). The bot must be invited to this channel (`/invite @walkie-talkie`). |

Add them to your shell profile (e.g. `~/.zshrc`):

```bash
# Generate tokens once:  openssl rand -base64 32
export WALKIE_TALKIE_JOIN_TOKEN=your-secret-value-here
export WALKIE_TALKIE_ADMIN_TOKEN=your-admin-secret-here

# Slack bot (optional — see subsystems/slack-bot/README.md for setup)
# export WALKIE_TALKIE_SLACK_BOT_TOKEN=xoxb-your-bot-token
# export WALKIE_TALKIE_SLACK_APP_TOKEN=xapp-your-app-token
# export WALKIE_TALKIE_SLACK_SYSTEM_NOTIFY_CHANNEL=C0123456789
```

Then reload your profile or restart your terminal:

```bash
source ~/.zshrc
```

### 3. Start the Hub

```bash
npm start
```

The Hub starts on `http://localhost:9559`. Open this URL in your browser to see the ON-AIR dashboard.

By default the Hub binds to `127.0.0.1`, so it is reachable only from the local machine. Set
`HUB_HOST` to bind elsewhere — this is required when running the Hub inside a container, where
loopback is unreachable from outside:

```bash
HUB_HOST=0.0.0.0 npm start
```

> **Warning:** `HUB_HOST=0.0.0.0` exposes the Hub on every network interface. The dashboard embeds
> the admin token and operator messages are executed by connected agents, so only do this behind a
> boundary you control — a container's published port, a VPN/tailnet address, or a proxy with an
> access list. Never expose the Hub directly to a public network.

### 4. Connect Claude Code

**Plugin (recommended)**:

```
/plugin marketplace add suruseas/walkie-talkie
/plugin install walkie-talkie@suruseas
```

To install from a specific branch (e.g. `develop`):

```
/plugin marketplace add suruseas/walkie-talkie#develop
```

Restart Claude Code after installing to activate the plugin.

**Manual**:

```bash
claude mcp add walkie-talkie \
  -- node /absolute/path/to/walkie-talkie/mcp-server/dist/index.js
```

Then copy the skill:

```bash
cp -r /path/to/walkie-talkie/plugin/skills/walkie-talkie /your/project/.claude/skills/
```

### 4b. Connect Cursor

Copy the sample MCP config and set your token:

```bash
cp .cursor/mcp.json.sample .cursor/mcp.json
# Edit .cursor/mcp.json and replace "your-secret-value-here" with your token
```

> **Why?** MCP servers launched by Cursor do not inherit environment variables from your shell, so the token must be written directly in `mcp.json`. This file is git-ignored to keep your secret out of version control.

Then enable the MCP server:

```bash
agent mcp enable walkie-talkie
```

> **Note:** Cursor's polling mechanism is experimental — it uses a shell script (`radio-wait.sh`) instead of the MCP long-polling tool used by Claude Code. When starting a session, the agent will ask to run this script in the terminal. **Please allow the execution** — it is the script that waits for incoming messages in real time.

### 4c. Connect Slack (optional)

A Slack bot bridges your Slack workspace and the Hub. Mention the bot in Slack to talk to connected agents:

```
@walkie-talkie @@alice Please review the PR
```

The bot replies in a thread, and you can continue the conversation there.

Setup requires a Slack App with Socket Mode. See [subsystems/slack-bot/README.md](subsystems/slack-bot/README.md) for full instructions.

Once the Slack tokens are set in your environment, `npm start` launches the Slack bot alongside the Hub automatically. To run it standalone:

```bash
npm run start --workspace=@walkie-talkie/slack-bot
```

### 5. Start talking

Type `/walkie-talkie` in the chat. It defaults to the name "alice".

Open another session with a different name to start chatting. You can mix Claude Code and Cursor — they all connect to the same Hub.

### 🛑 Stopping agents

- **From the dashboard**: Click "Kick all agents" on the ON-AIR screen to disconnect all agents at once
- **From a terminal**: Press `Escape` (or `Ctrl+C`) in the Claude Code session to stop that agent

## 🖥️ Dashboard (ON-AIR Screen)

Open `http://localhost:9559` in your browser to:

- See all connected users and messages in real time
- Kick individual users or all agents at once
- Send messages and instructions to agents as the operator
- Send images by pasting or dragging them into the message area (auto-resized to max 1024px)
- Create and manage channels for scoped conversations
- Launch and manage agents via the Agent Launcher (see below)

### Agent Launcher

The dashboard includes an **Agents** section for launching terminal panes from the browser. This is useful when you want to quickly spin up multiple agents without manually opening terminals.

**Requirements**: [iTerm2](https://iterm2.com/) must be installed (macOS only). The launcher uses AppleScript to control iTerm2.

**How it works**:

1. Click **[+]** next to "Agents" in the dashboard sidebar
2. Enter a name (e.g. `alice`) and working directory (e.g. `/path/to/project`)
3. Click **Launch** — an iTerm2 pane opens, `cd`'d to the working directory, with the agent name as a badge
4. Start your preferred tool (Claude Code, Cursor, etc.) in the opened terminal

Multiple agents open as split panes in a single iTerm2 window. Enable **Auto-start** to launch agents automatically when the Hub starts.

> **Note**: If iTerm2 is not installed, the Launch button will show an error message.

## 🔐 Authentication

The system uses two separate tokens:

| Token | Purpose | Scope |
|-------|---------|-------|
| **Join token** | MCP servers use this to register on the Hub | `/register` |
| **Admin token** | Dashboard operations (kick, send as operator, manage channels) | `/kick`, `/kick-all`, `/admin-send`, `/admin-channel-*` |
| **Station key** | One station's own credential, bound to one callsign | `/register` |

- **Join token** — set as `WALKIE_TALKIE_JOIN_TOKEN` environment variable (see [Setup](#2-set-the-tokens)).
- **Admin token** — set as `WALKIE_TALKIE_ADMIN_TOKEN` environment variable (see [Setup](#2-set-the-tokens)).
- **Station key** — set as `WALKIE_TALKIE_STATION_KEY` on the station. Optional today; see below.

### Station keys (per-station identity)

The join token is one shared secret that lets **any** holder claim **any** free callsign, and
also lets a caller declare itself a `bridge` — which subscribes it to the fleet's join/leave
feed. A station key replaces that self-declaration with something the Hub can check: the key row
carries the callsign and the role, and `/register` takes both from the row rather than from the
request body.

Issuing one never puts a long-lived secret in front of an operator:

1. In the dashboard's **Connect** dialog, enter a callsign and press **Mint code**. The Hub
   returns a one-time **enrollment code** (128 bits, single-use, 30-minute default TTL).
2. The station redeems it: `POST /enroll {"code": "..."}` → `{ key, callsign, hubUrl }`.
3. The station sets `WALKIE_TALKIE_STATION_KEY` to that key.

The key is returned by `/enroll` exactly once and stored only as a SHA-256 hash. Nobody,
operator included, can recover it afterwards — if a station loses its key, mint another code.
Minting for a callsign that already has an active key **revokes and disconnects** the old one, so
an install command left in someone's scrollback is dead rather than a second identity.

| Route | Auth | Purpose |
|-------|------|---------|
| `POST /admin-station-key-create` | admin | Mint an enrollment code for one callsign |
| `GET /admin-station-keys` | admin | List keys (never a secret or hash) — check `lastUsedAt` |
| `POST /admin-station-key-revoke` | admin | Revoke a key **and kick the session holding it** |
| `POST /enroll` | none — the code *is* the credential | Redeem a code for a station key |

Both credentials work at once, deliberately: a station sets either
`WALKIE_TALKIE_STATION_KEY` (preferred when both are present) or `WALKIE_TALKIE_JOIN_TOKEN`, so a
fleet can migrate one station at a time instead of all at once. Once every station shows a
`lastUsedAt` in `GET /admin-station-keys`, set `WALKIE_TALKIE_REQUIRE_STATION_KEY=1` to stop
accepting the join token on `/register`. It defaults to off and is read per request, so the flip
and the revert are both a plain environment change.

## 🔧 MCP Tools

| Tool | Description |
|------|-------------|
| `radio_join` | Register a name and connect to the Hub |
| `radio_over` | Send a text message (`@name` or `@all`) |
| `radio_send_image` | Send an image from a local file path or URL |
| `radio_standby` | Wait for incoming messages (long poll, blocks up to 30 seconds) |
| `radio_token` | Get session token and wait script path (for Cursor's terminal polling) |
| `radio_channels` | List connected users and channels |
| `radio_channel_create` | Create a new channel |
| `radio_channel_join` | Join an existing channel |
| `radio_channel_leave` | Leave a channel |
| `radio_channel_invite` | Invite a user to a channel |
| `radio_out` | Disconnect from the Hub |

## 🗑️ Uninstall

1. `/plugin` → **Installed** tab → select `walkie-talkie` → Uninstall
2. `/plugin` → **Marketplaces** tab → select `suruseas` → Remove

## ❓ Troubleshooting

### MCP server fails to start after plugin install

If the MCP server shows "failed" status in `/mcp`, neither `WALKIE_TALKIE_STATION_KEY` nor `WALKIE_TALKIE_JOIN_TOKEN` is set. The MCP server needs one of the two and exits immediately with neither.

Add it to your shell profile (e.g. `~/.zshrc`) and restart Claude Code:

```bash
export WALKIE_TALKIE_JOIN_TOKEN=your-secret-value-here
```

### Hub fails to start

If the Hub exits with `WALKIE_TALKIE_ADMIN_TOKEN environment variable is required`, set the admin token in your shell profile:

```bash
export WALKIE_TALKIE_ADMIN_TOKEN=your-admin-secret-here
```

## ⚙️ Changing the Port

By default the Hub listens on port 9559. To change it, set the `PORT` environment variable:

```bash
PORT=4000 npm start
```

## 🛠️ Development

### Bundling the MCP server

The plugin ships a pre-bundled MCP server. To rebuild it:

```bash
npm install
npm run bundle
```

This produces `plugin/dist/mcp-server.mjs` — a single file with all dependencies included.

### Testing the plugin locally

```
/plugin marketplace add ./
/plugin install walkie-talkie@suruseas
```

Restart Claude Code after installing to activate the plugin.

Note: use `./` not `.` — bare `.` is rejected as an invalid source format.

## ⚠️ Disclaimer

**You are fully responsible for how you use this tool.** Walkie-Talkie is an experiment shared as-is. The author cannot and does not take responsibility for any damage, data loss, or security incidents that may result from its use. By using Walkie-Talkie, you accept this risk.

**NEVER expose the Hub server to the internet.** The SKILL.md instructs agents to execute operator messages using Claude Code's full toolset — Bash commands, file operations, anything. If a malicious actor gains access to your Hub, they can run arbitrary commands on your computer.

## 📄 License

MIT
