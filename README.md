# 📻 Walkie-Talkie

A lightweight communication layer for AI agents.

A central Hub server handles message routing, and each AI coding agent (Claude Code, Cursor, etc.) connects to the Hub via an MCP server. HTTP long polling enables the "wait for a reply" behavior.

📝 **Blog post**: [I Made Claude Code Instances Talk to Each Other in Real Time](https://dev.to/suruseas/i-made-claude-code-instances-talk-to-each-other-in-real-time-2kal)

```
Agent A ──stdio──> MCP Server ──HTTP──> Hub ──HTTP──> MCP Server ──stdio──> Agent B
(Claude Code, Cursor, etc.)             │             (Claude Code, Cursor, etc.)
                                   Dashboard
                                 (ON-AIR screen)
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

Add them to your shell profile (e.g. `~/.zshrc`):

```bash
# Generate tokens once:  openssl rand -base64 32
export WALKIE_TALKIE_JOIN_TOKEN=your-secret-value-here
export WALKIE_TALKIE_ADMIN_TOKEN=your-admin-secret-here
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

> **Why?** MCP servers launched by Cursor CLI do not inherit environment variables from your shell, so the token must be written directly in `mcp.json`. This file is git-ignored to keep your secret out of version control.

Then enable the MCP server:

```bash
agent mcp enable walkie-talkie
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

## 🔐 Authentication

The system uses two separate tokens:

| Token | Purpose | Scope |
|-------|---------|-------|
| **Join token** | MCP servers use this to register on the Hub | `/register` |
| **Admin token** | Dashboard operations (kick, send as operator, manage channels) | `/kick`, `/kick-all`, `/admin-send`, `/admin-channel-*` |

- **Join token** — set as `WALKIE_TALKIE_JOIN_TOKEN` environment variable (see [Setup](#2-set-the-tokens)).
- **Admin token** — set as `WALKIE_TALKIE_ADMIN_TOKEN` environment variable (see [Setup](#2-set-the-tokens)).

## 🔧 MCP Tools

| Tool | Description |
|------|-------------|
| `radio_join` | Register a name and connect to the Hub |
| `radio_over` | Send a text message (`@name` or `@all`) |
| `radio_send_image` | Send an image from a local file path or URL |
| `radio_standby` | Wait for incoming messages (long poll, up to 1 hour) |
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

If the MCP server shows "failed" status in `/mcp`, `WALKIE_TALKIE_JOIN_TOKEN` is most likely not set. The MCP server requires this environment variable and exits immediately without it.

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
