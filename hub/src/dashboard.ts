import type { BuildInfo } from "./version.js";

export function getDashboardHTML(
  adminToken: string,
  installerUrl = "",
  build: BuildInfo = { version: "unknown", buildRev: null, startedAt: Date.now() },
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<!-- Inline SVG favicon (the wordmark glyph). Avoids a 404 on every load: the hub serves no
     static files, so a browser's automatic /favicon.ico request had nowhere to land. -->
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2334d399' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M12 10v10'/%3E%3Cpath d='M8 20h8'/%3E%3Ccircle cx='12' cy='6' r='2'/%3E%3Cpath d='M5 3c2.8 2.8 4 5 4 7'/%3E%3Cpath d='M19 3c-2.8 2.8-4 5-4 7'/%3E%3C/svg%3E">
<title>Walkie-Talkie</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg-base: #09090b;
    --bg-raised: #111114;
    --bg-surface: #18181b;
    --bg-hover: #1f1f23;
    --border: rgba(255,255,255,0.06);
    --border-subtle: rgba(255,255,255,0.04);
    --text-primary: #ececef;
    --text-secondary: #71717a;
    --text-tertiary: #52525b;
    --accent: #818cf8;
    --accent-soft: rgba(129,140,248,0.12);
    --green: #34d399;
    --green-soft: rgba(52,211,153,0.12);
    --green-border: rgba(52,211,153,0.2);
    --red: #f87171;
    --red-soft: rgba(248,113,113,0.1);
    --red-border: rgba(248,113,113,0.2);
    --yellow: #fbbf24;
    --yellow-soft: rgba(251,191,36,0.12);
    --radius: 10px;
    --font: 'DM Sans', -apple-system, sans-serif;
    --mono: 'Geist Mono', ui-monospace, monospace;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--font);
    background: var(--bg-base);
    color: var(--text-primary);
    height: 100vh;
    display: flex;
    flex-direction: column;
    -webkit-font-smoothing: antialiased;
  }

  /* Header */
  header {
    height: 52px;
    padding: 0 20px;
    background: var(--bg-raised);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 14px;
    flex-shrink: 0;
    backdrop-filter: blur(12px);
  }
  .logo {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .logo-icon {
    width: 22px;
    height: 22px;
    border-radius: 6px;
    background: linear-gradient(135deg, var(--accent), #a78bfa);
    display: grid;
    place-items: center;
  }
  .logo-icon svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: #fff;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  header h1 {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    letter-spacing: -0.01em;
  }
  .header-sep {
    width: 1px;
    height: 18px;
    background: var(--border);
  }
  #status {
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 500;
    padding: 3px 10px;
    border-radius: 100px;
    background: var(--green-soft);
    color: var(--green);
    border: 1px solid var(--green-border);
    transition: all 0.25s ease;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  #status::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 6px var(--green);
  }
  #status.disconnected {
    background: var(--red-soft);
    color: var(--red);
    border-color: var(--red-border);
  }
  #status.disconnected::before {
    background: var(--red);
    box-shadow: 0 0 6px var(--red);
  }
  .header-spacer { flex: 1; }
  #channel-header {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .channel-members {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-tertiary);
    font-weight: 400;
  }
  .clear-btn, .filter-btn {
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 500;
    padding: 4px 12px;
    background: transparent;
    color: var(--text-tertiary);
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .clear-btn:hover, .filter-btn:hover {
    color: var(--text-secondary);
    border-color: rgba(255,255,255,0.1);
    background: var(--bg-hover);
  }
  .clear-btn:active, .filter-btn:active {
    transform: scale(0.97);
  }
  .filter-btn.active {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: rgba(129,140,248,0.3);
  }
  body.filter-operator .msg:not(.operator):not(.system) {
    opacity: 0.3;
  }

  /* Main */
  .container {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  /* Sidebar */
  #sidebar {
    width: 220px;
    background: var(--bg-raised);
    border-right: 1px solid var(--border);
    padding: 16px 12px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow-y: auto;
  }
  .sidebar-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
    padding: 0 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .sidebar-label .add-btn {
    font-family: var(--mono);
    font-size: 11px;
    background: transparent;
    color: var(--text-tertiary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 6px;
    cursor: pointer;
    transition: all 0.15s ease;
    line-height: 18px;
  }
  .sidebar-label .add-btn:hover {
    color: var(--accent);
    border-color: rgba(129,140,248,0.3);
    background: var(--accent-soft);
  }

  /* Channel list */
  #channel-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  #channel-list li {
    padding: 6px 8px;
    font-family: var(--mono);
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s ease;
    color: var(--text-secondary);
  }
  #channel-list li:hover {
    background: var(--bg-hover);
  }
  #channel-list li.active {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .channel-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .channel-unread {
    font-family: var(--mono);
    font-size: 10px;
    background: var(--accent);
    color: #fff;
    padding: 1px 6px;
    border-radius: 100px;
    flex-shrink: 0;
    font-weight: 600;
  }
  #channel-list li.active .channel-unread {
    display: none;
  }
  .channel-del {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-tertiary);
    font-family: var(--mono);
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
    opacity: 0;
    /* Invisible must also mean unclickable. opacity:0 still hit-tests, so
       without this the delete control stays a live target sitting under the
       cursor at the right edge of every row. */
    pointer-events: none;
    flex-shrink: 0;
    margin-left: 4px;
  }
  #channel-list li:hover .channel-del {
    opacity: 1;
    pointer-events: auto;
  }
  .channel-del:hover {
    border-color: var(--red-border);
    color: var(--red);
    background: var(--red-soft);
  }

  /* User list */
  #user-list {
    list-style: none;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  #user-list li {
    padding: 7px 8px;
    font-size: 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-radius: 8px;
    transition: background 0.15s ease;
  }
  #user-list li:hover {
    background: var(--bg-hover);
  }
  .user-info {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }
  .user-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 8px rgba(52,211,153,0.35);
    flex-shrink: 0;
  }
  .user-dot.offline {
    background: #555;
    box-shadow: none;
  }
  /* Registered and not detected-offline, but no long-poll is open and the last one
     started a while ago — i.e. nobody is actually listening on this handle. Distinct
     from .offline, which means the hub already saw the connection drop. */
  .user-dot.stale {
    background: var(--yellow);
    box-shadow: 0 0 8px rgba(251,191,36,0.35);
  }
  .stale-badge {
    font-family: var(--mono);
    font-size: 10px;
    line-height: 1;
    padding: 2px 5px;
    border-radius: 4px;
    color: var(--yellow);
    background: var(--yellow-soft);
    flex-shrink: 0;
  }
  .user-name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
  }
  .kick-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-tertiary);
    font-family: var(--mono);
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
    opacity: 0;
    /* Invisible must also mean unclickable. opacity:0 leaves the button in the
       hit-test tree, so an unhovered row still had a live kick target parked at
       its right edge -- a stray click there disconnected an agent with nothing
       on screen to explain it. */
    pointer-events: none;
    flex-shrink: 0;
  }
  #user-list li:hover .kick-btn {
    opacity: 1;
    pointer-events: auto;
  }
  .kick-btn:hover {
    border-color: var(--red-border);
    color: var(--red);
    background: var(--red-soft);
  }
  #stop-all {
    width: 100%;
    padding: 8px;
    background: var(--red-soft);
    color: var(--red);
    border: 1px solid var(--red-border);
    border-radius: 8px;
    font-family: var(--font);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  #stop-all:hover {
    background: rgba(248,113,113,0.18);
    border-color: rgba(248,113,113,0.35);
  }
  #stop-all:active {
    transform: scale(0.98);
  }

  /* Agent list */
  #agent-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  #agent-list li {
    padding: 7px 8px;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-radius: 8px;
    transition: background 0.15s ease;
  }
  #agent-list li:hover {
    background: var(--bg-hover);
  }
  .agent-info {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }
  .agent-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .agent-dot.online {
    background: var(--green);
    box-shadow: 0 0 8px rgba(52,211,153,0.35);
  }
  .agent-dot.offline {
    background: #555;
    box-shadow: none;
  }
  .agent-name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
  }
  .agent-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .agent-actions button {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-tertiary);
    font-family: var(--mono);
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
    opacity: 0;
    /* Same invisible-but-clickable trap as .kick-btn and .channel-del: these
       are launch / edit / delete, so a blind click here starts or destroys an
       agent config. */
    pointer-events: none;
  }
  #agent-list li:hover .agent-actions button {
    opacity: 1;
    pointer-events: auto;
  }
  .agent-launch-btn:hover {
    border-color: var(--green-border) !important;
    color: var(--green) !important;
    background: var(--green-soft) !important;
  }
  .agent-edit-btn:hover {
    border-color: rgba(129,140,248,0.3) !important;
    color: var(--accent) !important;
    background: var(--accent-soft) !important;
  }
  .agent-del-btn:hover {
    border-color: var(--red-border) !important;
    color: var(--red) !important;
    background: var(--red-soft) !important;
  }

  /* Agent dialog */
  .dialog-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .dialog {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px;
    width: 420px;
    max-width: 90vw;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .dialog h2 {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }
  .dialog label {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .dialog input, .dialog textarea {
    font-family: var(--mono);
    font-size: 13px;
    padding: 8px 10px;
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 8px;
    outline: none;
    transition: border-color 0.15s ease;
  }
  .dialog input:focus, .dialog textarea:focus {
    border-color: var(--accent);
  }
  .dialog input::placeholder, .dialog textarea::placeholder {
    color: var(--text-tertiary);
  }
  .dialog textarea {
    resize: vertical;
    min-height: 60px;
  }
  .dialog .checkbox-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text-secondary);
  }
  .dialog .checkbox-row input[type="checkbox"] {
    width: 16px;
    height: 16px;
    accent-color: var(--accent);
  }
  .dialog .dialog-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .dialog .dialog-buttons button {
    font-family: var(--font);
    font-size: 13px;
    font-weight: 500;
    padding: 8px 16px;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  /* Build identity beside the wordmark */
  .build-chip {
    font-family: var(--mono);
    font-size: 10px;
    line-height: 1;
    padding: 3px 6px;
    border-radius: 5px;
    color: var(--text-tertiary);
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    cursor: default;
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* Connect / installer modal */
  .connect-dialog { width: 560px; gap: 14px; }
  .connect-lead, .connect-note {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-secondary);
  }
  .connect-prereq { color: var(--text-tertiary); }
  .connect-step { display: flex; flex-direction: column; gap: 6px; }
  .connect-mint { display: flex; align-items: center; gap: 8px; }
  .connect-mint input {
    flex: 1;
    min-width: 0;
    font-family: var(--font);
    font-size: 12px;
    padding: 6px 9px;
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .mint-btn {
    font-family: var(--font);
    font-size: 11px;
    padding: 6px 12px;
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .mint-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
  .mint-btn:disabled { opacity: 0.5; cursor: default; }
  .mint-error { color: var(--red); }
  .connect-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-tertiary);
  }
  .connect-cmd {
    display: flex;
    align-items: stretch;
    gap: 8px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 8px 8px 10px;
  }
  .connect-cmd code {
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-primary);
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    white-space: pre;
  }
  .inline-code {
    font-family: var(--mono);
    font-size: 11px;
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .copy-btn {
    font-family: var(--font);
    font-size: 11px;
    padding: 3px 9px;
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
    flex-shrink: 0;
    align-self: center;
    transition: color 0.15s ease, background 0.15s ease;
  }
  .copy-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
  .copy-btn.copied { color: var(--green); border-color: var(--green-border); background: var(--green-soft); }
  @media (max-width: 768px) {
    .connect-dialog { width: 100%; padding: 18px; }
    .connect-cmd { flex-direction: column; align-items: stretch; gap: 6px; }
    .copy-btn { align-self: flex-start; }
  }
  .dialog .btn-cancel {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }
  .dialog .btn-cancel:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .dialog .btn-save {
    background: var(--accent);
    color: #fff;
    border: 1px solid var(--accent);
  }
  .dialog .btn-save:hover {
    opacity: 0.9;
  }

  /* Messages */
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px 24px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    scrollbar-width: thin;
    scrollbar-color: var(--bg-surface) transparent;
  }
  #messages::-webkit-scrollbar { width: 5px; }
  #messages::-webkit-scrollbar-track { background: transparent; }
  #messages::-webkit-scrollbar-thumb { background: var(--bg-surface); border-radius: 8px; }

  .msg {
    padding: 10px 14px;
    border-radius: var(--radius);
    font-size: 16px;
    line-height: 1.6;
    max-width: 100%;
    animation: slideIn 0.25s cubic-bezier(0.16,1,0.3,1);
    border: 1px solid transparent;
  }
  .msg .time {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-tertiary);
    margin-right: 8px;
  }
  .msg .channel-tag {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--yellow);
    background: var(--yellow-soft);
    padding: 1px 6px;
    border-radius: 4px;
    margin-right: 6px;
  }
  .msg .from {
    font-weight: 600;
    color: var(--accent);
  }
  .msg .to {
    font-family: var(--mono);
    font-size: 14px;
    color: var(--text-tertiary);
    margin-left: 2px;
  }
  .msg .content {
    margin-top: 4px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-primary);
  }
  .msg.message {
    background: var(--bg-surface);
    border-color: var(--border-subtle);
  }
  .msg.message:hover {
    border-color: var(--border);
  }
  .msg.operator {
    background: var(--accent-soft);
    border-color: rgba(129,140,248,0.18);
    border-left: 3px solid var(--accent);
  }
  /* Wall announcements: system broadcasts (restart warnings etc). Deliberately distinct from
     operator styling — a wall message is informational and carries no authority to task agents. */
  .msg.wall {
    background: var(--yellow-soft);
    border-color: rgba(251,191,36,0.2);
    border-left: 3px solid var(--yellow);
  }
  .msg.operator:hover {
    border-color: rgba(129,140,248,0.3);
    border-left-color: var(--accent);
  }
  .msg.system {
    background: transparent;
    font-size: 15px;
    color: var(--text-tertiary);
    max-width: 100%;
    padding: 6px 14px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .msg.system::before {
    content: "";
    flex: 0 0 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--green);
  }
  .msg.system.leave::before {
    background: var(--red);
  }
  .msg.system.channel-event::before {
    background: var(--yellow);
  }
  .msg.system strong {
    color: var(--text-secondary);
    font-weight: 500;
  }
  .empty {
    color: var(--text-tertiary);
    text-align: center;
    margin-top: 36vh;
    font-size: 13px;
  }

  /* Message area wrapper */
  .message-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  /* Input bar */
  .input-bar {
    padding: 12px 16px;
    background: var(--bg-raised);
    border-top: 1px solid var(--border);
    display: flex;
    align-items: flex-end;
    gap: 8px;
    flex-shrink: 0;
  }
  .input-bar-wrapper {
    position: relative;
    display: flex;
    align-items: flex-end;
    gap: 8px;
    flex: 1;
    min-width: 0;
  }
  .input-tag {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 500;
    padding: 6px 10px;
    border-radius: 6px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 1px;
    user-select: none;
  }
  .input-tag.channel {
    background: var(--yellow-soft);
    color: var(--yellow);
    border: 1px solid rgba(251,191,36,0.2);
  }
  .input-tag.recipient {
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid rgba(129,140,248,0.2);
    cursor: default;
  }
  .input-tag .tag-remove {
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.6;
    transition: opacity 0.15s ease;
  }
  .input-tag .tag-remove:hover {
    opacity: 1;
  }
  .mention-popup {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 6px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    min-width: 180px;
    max-height: 200px;
    overflow-y: auto;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    z-index: 100;
    display: none;
    scrollbar-width: thin;
    scrollbar-color: var(--bg-surface) transparent;
  }
  .mention-popup.visible {
    display: block;
    animation: slideIn 0.15s cubic-bezier(0.16,1,0.3,1);
  }
  .mention-item {
    padding: 8px 12px;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-secondary);
    cursor: pointer;
    transition: background 0.1s ease;
  }
  .mention-item:hover, .mention-item.active {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .mention-item:first-child { border-radius: 7px 7px 0 0; }
  .mention-item:last-child { border-radius: 0 0 7px 7px; }
  .mention-item:only-child { border-radius: 7px; }
  .input-bar textarea {
    flex: 1;
    font-family: var(--font);
    font-size: 13px;
    padding: 8px 12px;
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 8px;
    outline: none;
    resize: none;
    overflow-y: hidden;
    line-height: 1.5;
    min-height: 36px;
    max-height: 120px;
    field-sizing: content;
  }
  .input-bar textarea::placeholder {
    color: var(--text-tertiary);
  }
  .input-bar textarea:focus {
    border-color: var(--accent);
  }
  .send-btn {
    font-family: var(--font);
    font-size: 12px;
    font-weight: 600;
    padding: 8px 16px;
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s ease;
    flex-shrink: 0;
  }
  .send-btn:hover {
    opacity: 0.85;
  }
  .send-btn:active {
    transform: scale(0.97);
  }
  .send-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .msg.hidden-by-filter {
    display: none;
  }

  .typing-indicator {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--accent);
    margin-left: 6px;
    animation: typingBlink 1.2s ease-in-out infinite;
  }
  #typing-bar {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--accent);
    padding: 0 24px;
    height: 0;
    overflow: hidden;
    transition: height 0.2s ease, padding 0.2s ease;
  }
  #typing-bar.active {
    height: 28px;
    padding: 6px 24px;
  }
  #image-preview {
    display: none;
    align-items: center;
    padding: 8px 16px;
    gap: 10px;
    border-top: 1px solid var(--border);
    background: var(--bg-raised);
  }
  #image-preview.active {
    display: flex;
  }
  #image-preview img {
    max-width: 120px;
    max-height: 80px;
    border-radius: 6px;
    border: 1px solid var(--border);
  }
  #image-preview .remove-img {
    font-family: var(--mono);
    font-size: 11px;
    background: transparent;
    color: var(--text-tertiary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  #image-preview .remove-img:hover {
    border-color: var(--red-border);
    color: var(--red);
    background: var(--red-soft);
  }
  .msg-image img {
    max-width: 300px;
    max-height: 200px;
    border-radius: 6px;
    margin-top: 6px;
    border: 1px solid var(--border);
    cursor: pointer;
  }
  .msg-image img:hover {
    border-color: rgba(255,255,255,0.15);
  }
  @keyframes typingBlink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  @keyframes slideIn {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* Mobile sidebar toggle — hidden on desktop */
  .menu-toggle {
    display: none;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .menu-toggle:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }
  .menu-toggle svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }
  #sidebar-backdrop {
    display: none;
    position: fixed;
    inset: 52px 0 0 0;
    background: rgba(0,0,0,0.5);
    z-index: 40;
  }
  #sidebar-backdrop.open { display: block; }

  /* Responsive: phones / narrow viewports */
  @media (max-width: 768px) {
    .menu-toggle { display: flex; }
    header { padding: 0 12px; gap: 10px; }
    /* Header is tight at phone widths; the wordmark and the diagnostic chip both go. */
    .header-sep, header h1, .build-chip { display: none; }
    #channel-header { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #channel-header .channel-members { display: none; }
    .filter-btn, .clear-btn { padding: 4px 9px; }

    /* Sidebar slides in as an off-canvas drawer */
    #sidebar {
      position: fixed;
      top: 52px;
      bottom: 0;
      left: 0;
      z-index: 50;
      width: 78%;
      max-width: 300px;
      transform: translateX(-100%);
      transition: transform 0.22s cubic-bezier(0.16,1,0.3,1);
    }
    #sidebar.open { transform: translateX(0); }

    #messages { padding: 14px 14px; }
    .msg { font-size: 15px; }
    .msg-image img { max-width: 100%; }

    /* Input bar wraps: full-width textarea on top, tags + Send below */
    .input-bar { flex-wrap: wrap; padding: 10px 12px; gap: 6px; }
    .input-bar-wrapper { order: 0; flex-basis: 100%; min-width: 0; }
    .input-tag { order: 1; margin-bottom: 0; }
    .send-btn { order: 2; margin-left: auto; }
  }
</style>
</head>
<body>
  <header>
    <button class="menu-toggle" id="menu-toggle" aria-label="Toggle menu">
      <svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/></svg>
    </button>
    <div class="logo">
      <div class="logo-icon">
        <svg viewBox="0 0 24 24"><path d="M12 10v10"/><path d="M8 20h8"/><circle cx="12" cy="6" r="2"/><path d="M5 3c2.8 2.8 4 5 4 7" opacity=".6"/><path d="M19 3c-2.8 2.8-4 5-4 7" opacity=".6"/></svg>
      </div>
      <h1>Walkie-Talkie</h1>
      <span class="build-chip" id="build-chip" title=""></span>
    </div>
    <div class="header-sep"></div>
    <span id="status">connected</span>
    <span id="channel-header"></span>
    <div class="header-spacer"></div>
    <button class="filter-btn" id="connect-btn" title="How to connect an agent">Connect</button>
    <button class="filter-btn" id="filter-btn">My messages</button>
    <button class="clear-btn" id="clear-btn">Clear</button>
  </header>
  <div id="sidebar-backdrop"></div>
  <div class="container">
    <div id="sidebar">
      <span class="sidebar-label">Channels <button class="add-btn" id="add-channel-btn">+ New</button></span>
      <ul id="channel-list"></ul>
      <span class="sidebar-label">On Air</span>
      <ul id="user-list"></ul>
      <span class="sidebar-label">Agents <button class="add-btn" id="add-agent-btn">+ New</button></span>
      <ul id="agent-list"></ul>
      <button id="stop-all">Kick all agents</button>
    </div>
    <div class="message-area">
      <div id="messages">
        <div class="empty">Waiting for transmissions...</div>
      </div>
      <div id="typing-bar"></div>
      <div id="image-preview"></div>
      <div class="input-bar">
        <span class="input-tag channel" id="channel-tag">#all</span>
        <span class="input-tag recipient" id="recipient-tag">@all</span>
        <div class="input-bar-wrapper">
          <div class="mention-popup" id="mention-popup"></div>
          <textarea id="send-input" placeholder="Send a message... (type @ to mention)" rows="1"></textarea>
        </div>
        <button class="send-btn" id="send-btn">Send</button>
      </div>
    </div>
  </div>
  <div class="dialog-overlay" id="connect-dialog" style="display:none">
    <div class="dialog connect-dialog">
      <h2>Connect an agent</h2>
      <p class="connect-lead">Run the installer on the machine you want to connect. It is safe to
        re-run &mdash; it reinstalls the MCP server and refreshes the credential.</p>

      <div class="connect-step">
        <span class="connect-label">Optional &mdash; mint a per-station key</span>
        <div class="connect-mint">
          <input type="text" id="mint-callsign" placeholder="callsign, e.g. alpha" autocomplete="off" spellcheck="false">
          <button class="mint-btn" id="mint-btn">Mint code</button>
        </div>
        <p class="connect-note" id="mint-status"></p>
        <div class="connect-cmd" id="mint-code-row" style="display:none"><code id="mint-code"></code><button class="copy-btn" data-copy="mint-code">Copy</button></div>
        <p class="connect-note connect-prereq">An enrollment code is single-use and expires. The
          station key it redeems is bound to that one callsign, is shown once, and is stored here
          only as a hash &mdash; nobody, including you, can recover it afterwards. If a station
          loses its key, mint another code; minting for a callsign that already has an active key
          revokes the old one and disconnects it. Redeem with
          <code class="inline-code">POST /enroll</code> or an installer revision that accepts a
          code. Without one, the installer still configures the shared join token as before.</p>
      </div>

      <div class="connect-step">
        <span class="connect-label">Linux &middot; macOS &middot; WSL &mdash; Claude Code</span>
        <div class="connect-cmd"><code id="connect-sh"></code><button class="copy-btn" data-copy="connect-sh">Copy</button></div>
      </div>

      <div class="connect-step">
        <span class="connect-label">Windows &mdash; Claude Code</span>
        <div class="connect-cmd"><code id="connect-ps"></code><button class="copy-btn" data-copy="connect-ps">Copy</button></div>
      </div>

      <div class="connect-step">
        <span class="connect-label">Windows &mdash; Gemini CLI</span>
        <div class="connect-cmd"><code id="connect-ps-gemini"></code><button class="copy-btn" data-copy="connect-ps-gemini">Copy</button></div>
      </div>

      <div class="connect-step">
        <span class="connect-label">Then</span>
        <p class="connect-note"><strong>Restart your CLI</strong> — the MCP server is spawned at
          startup, so a running session keeps the old build. Then, in <strong>Claude Code</strong>, run
          <code class="inline-code">/walkie-talkie &lt;yourname&gt;</code>. <strong>Gemini CLI</strong> has no
          slash commands — ask it to get on the walkie-talkie net and give it your callsign, and the skill
          activates from its description.</p>
      </div>

      <p class="connect-note connect-prereq">Requires Node 18+, the matching CLI
        (<code class="inline-code">claude</code> or <code class="inline-code">gemini</code>), and network
        access to this host. The installer checks all three before changing anything.</p>

      <div class="dialog-buttons">
        <button class="btn-cancel" id="connect-dialog-close">Close</button>
      </div>
    </div>
  </div>

  <div class="dialog-overlay" id="agent-dialog" style="display:none">
    <div class="dialog">
      <h2 id="agent-dialog-title">New Agent</h2>
      <input type="hidden" id="agent-dialog-id">
      <label>Name <span style="font-weight:400;color:var(--text-tertiary)">(a-z, 0-9, hyphen, underscore)</span>
        <input type="text" id="agent-dialog-name" placeholder="alice" pattern="[a-zA-Z0-9_-]+">
        <span id="agent-dialog-name-error" style="color:var(--red);font-size:11px;display:none"></span>
      </label>
      <label>Working Directory
        <input type="text" id="agent-dialog-workdir" placeholder="/path/to/project">
      </label>
      <div class="checkbox-row">
        <input type="checkbox" id="agent-dialog-autostart">
        <label for="agent-dialog-autostart" style="flex-direction:row;gap:0">Auto-start on Hub launch</label>
      </div>
      <div class="dialog-buttons">
        <button class="btn-cancel" id="agent-dialog-cancel">Cancel</button>
        <button class="btn-save" id="agent-dialog-save">Save</button>
      </div>
    </div>
  </div>
  <script>
    const ADMIN_TOKEN = "${adminToken}";
    // Optional WALKIE_TALKIE_INSTALLER_URL. Empty when unset, in which case the client derives
    // a same-host default — the dashboard and installer are served from the same machine.
    const INSTALLER_URL = "${installerUrl}";
    const BUILD = { version: "${build.version}", buildRev: ${build.buildRev ? `"${build.buildRev}"` : "null"}, startedAt: ${build.startedAt} };
    const adminHeaders = { "Content-Type": "application/json", "Authorization": "Bearer " + ADMIN_TOKEN };
    const messagesEl = document.getElementById("messages");
    const userListEl = document.getElementById("user-list");
    const channelListEl = document.getElementById("channel-list");
    const statusEl = document.getElementById("status");
    const channelHeaderEl = document.getElementById("channel-header");
    const users = new Map(); // name -> online (boolean)

    // Per-user listener liveness from GET /users: name -> { hasActivePoll, lastSeen, firstSeen }.
    // Kept separate from the users map because SSE never carries these fields — join/leave/
    // status events only report online — so these are refreshed by polling /users, not pushed.
    const liveness = new Map();

    // A handle is "stale" when the hub still considers it registered and online, but no
    // long-poll is open and none has started recently. hasActivePoll is the primary signal:
    // lastSeen alone is unreliable because it is stamped at poll START and a healthy poll can
    // hold open for the whole poll timeout, so a quiet-but-alive listener reads as older
    // than it is.
    //
    // The grace exists only to cover the brief gap between one poll returning and the next
    // being issued; without it every agent would blink amber on each poll cycle.
    const STALE_AFTER_MS = 60_000;
    const USERS_REFRESH_MS = 15_000;

    // Milliseconds a handle has been not-listening, or null if it is fine (or offline, where
    // the grey dot already says it). Falls back to when we first observed a user that has
    // never polled, so a just-joined agent gets the same grace instead of flashing amber.
    function staleFor(name) {
      if (!users.get(name)) return null;
      const l = liveness.get(name);
      if (!l || l.hasActivePoll) return null;
      const since = l.lastSeen ?? l.firstSeen;
      const age = Date.now() - since;
      return age > STALE_AFTER_MS ? age : null;
    }

    function shortDuration(ms) {
      const s = Math.round(ms / 1000);
      if (s < 60) return s + "s";
      const m = Math.round(s / 60);
      if (m < 60) return m + "m";
      const h = Math.floor(m / 60);
      return h + "h" + (m % 60 ? String(m % 60) + "m" : "");
    }
    const channels = new Map(); // name -> { memberCount, createdBy, members }
    const typingUsers = new Map(); // name -> { timeoutId, channel }
    const pendingReply = new Map(); // name -> timeoutId (30s no-TYPING → grey)
    const agentConfigs = new Map(); // id -> { name, workDir, command, autoStart, status, pid, exitCode }
    const agentListEl = document.getElementById("agent-list");

    let selectedChannel = "#all";
    const unreadCounts = {}; // channel -> count

    function formatTime(ts) {
      return new Date(ts).toLocaleTimeString();
    }

    function clearEmpty() {
      const empty = messagesEl.querySelector(".empty");
      if (empty) empty.remove();
    }

    function scrollBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function kick(name) {
      // Kicking revokes the station's registration and token, so it cannot undo
      // itself the way deleting a channel or an agent config can -- yet those
      // were the only two guarded actions. Guard the one that costs the most.
      if (!confirm("Kick " + name + "? Their registration and token are revoked.")) return;
      fetch("/kick", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ name }),
      });
    }

    const typingBarEl = document.getElementById("typing-bar");
    function renderTypingBar() {
      const names = [...typingUsers.entries()].filter(([, v]) => v.channel === selectedChannel).map(([k]) => k);
      if (names.length === 0) {
        typingBarEl.className = "";
        typingBarEl.textContent = "";
      } else {
        typingBarEl.className = "active";
        typingBarEl.textContent = names.join(", ") + (names.length === 1 ? " is thinking..." : " are thinking...");
      }
    }

    function renderUsers() {
      userListEl.innerHTML = "";
      for (const [u, online] of users) {
        const li = document.createElement("li");
        const info = document.createElement("span");
        info.className = "user-info";
        const stale = staleFor(u);
        const dotCls = !online ? "user-dot offline" : stale ? "user-dot stale" : "user-dot";
        const tu = typingUsers.get(u);
        const typingHtml = tu && tu.channel === selectedChannel ? '<span class="typing-indicator">typing...</span>' : '';
        // Amber dot + elapsed badge: registered, but nothing is polling on this handle.
        const staleHtml = stale ? '<span class="stale-badge">' + shortDuration(stale) + '</span>' : '';
        info.innerHTML = '<span class="' + dotCls + '"></span><span class="user-name">' + u + '</span>' + typingHtml + staleHtml;
        if (stale) {
          li.title = u + " is registered but not polling — no listener has been open for "
            + shortDuration(stale) + ". The agent may be busy, or its listener may have died.";
        }
        const btn = document.createElement("button");
        btn.className = "kick-btn";
        btn.textContent = "kick";
        btn.onclick = () => kick(u);
        li.appendChild(info);
        li.appendChild(btn);
        userListEl.appendChild(li);
      }
      // Reset recipient if the current target left
      if (recipientTarget !== "@all") {
        const targetName = recipientTarget.slice(1);
        if (!users.has(targetName)) setRecipient("@all");
      }
      updateChannelHeader();
    }

    function renderAgents() {
      agentListEl.innerHTML = "";
      for (const [id, agent] of agentConfigs) {
        const li = document.createElement("li");
        const info = document.createElement("span");
        info.className = "agent-info";
        const isOnline = users.has(agent.name) && users.get(agent.name);
        info.innerHTML = '<span class="agent-dot ' + (isOnline ? 'online' : 'offline') + '"></span><span class="agent-name">' + agent.name + '</span>';
        const actions = document.createElement("span");
        actions.className = "agent-actions";
        const launchBtn = document.createElement("button");
        launchBtn.className = "agent-launch-btn";
        launchBtn.textContent = "launch";
        launchBtn.onclick = (e) => { e.stopPropagation(); agentLaunch(id); };
        actions.appendChild(launchBtn);
        if (!isOnline) {
          const editBtn = document.createElement("button");
          editBtn.className = "agent-edit-btn";
          editBtn.textContent = "edit";
          editBtn.onclick = (e) => { e.stopPropagation(); openAgentDialog(id, agent); };
          actions.appendChild(editBtn);
          const delBtn = document.createElement("button");
          delBtn.className = "agent-del-btn";
          delBtn.textContent = "x";
          delBtn.onclick = (e) => { e.stopPropagation(); if (confirm("Delete agent config '" + agent.name + "'?")) agentDelete(id); };
          actions.appendChild(delBtn);
        }
        li.appendChild(info);
        li.appendChild(actions);
        agentListEl.appendChild(li);
      }
    }

    function agentLaunch(id) {
      fetch("/admin-agent-start", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ id }),
      }).then(r => r.json()).then(data => {
        if (data.error) alert(data.error);
      }).catch(() => {});
    }

    function agentDelete(id) {
      fetch("/admin-agent-config-delete", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ id }),
      }).then(r => r.json()).then(data => {
        if (data.error) alert(data.error);
      }).catch(() => {});
    }

    function refreshAgentConfigs() {
      fetch("/admin-agent-configs", { headers: { "Authorization": "Bearer " + ADMIN_TOKEN } })
        .then(r => r.json())
        .then(data => {
          agentConfigs.clear();
          for (const c of data.configs) {
            agentConfigs.set(c.id, { name: c.name, workDir: c.workDir, autoStart: c.autoStart });
          }
          renderAgents();
        }).catch(() => {});
    }

    function refreshChannels() {
      fetch("/channels").then(r => r.json()).then(data => {
        channels.clear();
        for (const ch of data.channels) {
          channels.set(ch.name, { memberCount: ch.memberCount, createdBy: ch.createdBy, members: ch.members || [] });
        }
        renderChannels();
        updateChannelHeader();
      }).catch(() => {});
    }

    function renderChannels() {
      channelListEl.innerHTML = "";
      for (const [name, info] of channels) {
        const li = document.createElement("li");
        const unread = unreadCounts[name] || 0;
        const unreadBadge = unread > 0 ? '<span class="channel-unread">' + unread + '</span>' : '';
        if (name === "#all") {
          li.innerHTML = '<span class="channel-name">' + name + '</span>' + unreadBadge;
        } else {
          li.innerHTML = '<span class="channel-name">' + name + '</span>' + unreadBadge + '<button class="channel-del">x</button>';
          li.querySelector(".channel-del").onclick = (e) => {
            e.stopPropagation();
            if (confirm("Delete " + name + "?")) deleteChannel(name);
          };
        }
        if (selectedChannel === name) li.className = "active";
        li.onclick = () => selectChannel(name);
        channelListEl.appendChild(li);
      }
    }

    function updateChannelHeader() {
      if (!selectedChannel) {
        channelHeaderEl.innerHTML = "";
        return;
      }
      let membersHtml = "";
      if (selectedChannel === "#all") {
        const onlineUsers = [...users.keys()];
        const count = onlineUsers.length;
        const names = onlineUsers.join(", ");
        membersHtml = count > 0
          ? '<span class="channel-members">' + count + (count === 1 ? ' member' : ' members') + ': ' + names + '</span>'
          : '<span class="channel-members">0 members</span>';
      } else {
        const chInfo = channels.get(selectedChannel);
        const members = chInfo ? chInfo.members : [];
        const count = members.length;
        const names = members.join(", ");
        membersHtml = count > 0
          ? '<span class="channel-members">' + count + (count === 1 ? ' member' : ' members') + ': ' + names + '</span>'
          : '<span class="channel-members">0 members</span>';
      }
      channelHeaderEl.innerHTML = '<span>' + selectedChannel + '</span> — ' + membersHtml;
    }

    function markChannelRead(channel) {
      fetch("/admin-mark-read", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ channel }),
      }).catch(() => {});
      delete unreadCounts[channel];
      renderChannels();
    }

    function selectChannel(name) {
      selectedChannel = name;
      channelTagEl.textContent = name || "#all";
      updateChannelHeader();
      // Reset recipient if not a member of the new channel
      if (recipientTarget !== "@all" && name !== "#all") {
        const chInfo = channels.get(name);
        const members = chInfo ? chInfo.members : [];
        if (members.length > 0 && !members.includes(recipientTarget.slice(1))) {
          setRecipient("@all");
        }
      }
      markChannelRead(name);
      applyChannelFilter();
      renderTypingBar();
      renderUsers();
    }

    function applyChannelFilter() {
      const msgs = messagesEl.querySelectorAll(".msg");
      for (const msg of msgs) {
        if (!selectedChannel) {
          msg.classList.remove("hidden-by-filter");
        } else {
          const ch = msg.dataset.channel;
          if (!ch) {
            msg.classList.remove("hidden-by-filter");
          } else if (ch === selectedChannel) {
            msg.classList.remove("hidden-by-filter");
          } else {
            msg.classList.add("hidden-by-filter");
          }
        }
      }
    }

    function addMessage(html, cls, channel) {
      clearEmpty();
      const div = document.createElement("div");
      div.className = "msg " + cls;
      if (channel) div.dataset.channel = channel;
      div.innerHTML = html;
      if (selectedChannel && channel && channel !== selectedChannel) {
        div.classList.add("hidden-by-filter");
      }
      messagesEl.appendChild(div);
      scrollBottom();
    }

    document.getElementById("stop-all").onclick = () => {
      // Count the same set the hub does: /kick-all skips "operator".
      const targets = [...users.keys()].filter((u) => u !== "operator");
      if (targets.length === 0) return;
      const label = targets.length === 1 ? " station" : " stations";
      if (!confirm("Kick all " + targets.length + label + "? Every one loses its registration and token.")) return;
      fetch("/kick-all", { method: "POST", headers: adminHeaders });
    };

    // Send from dashboard
    const sendInputEl = document.getElementById("send-input");
    const sendBtnEl = document.getElementById("send-btn");
    const channelTagEl = document.getElementById("channel-tag");
    const recipientTagEl = document.getElementById("recipient-tag");
    const mentionPopupEl = document.getElementById("mention-popup");
    let recipientTarget = "@all";
    const MAX_IMAGE_SIZE = 1024; // max長辺 px
    let pendingImage = null; // { data, mimeType }

    function resizeImage(file, maxSize, callback) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const img = new Image();
        img.onload = () => {
          const w = img.width;
          const h = img.height;
          if (w <= maxSize && h <= maxSize) {
            callback(dataUrl.split(",")[1]);
            return;
          }
          const scale = maxSize / Math.max(w, h);
          const nw = Math.round(w * scale);
          const nh = Math.round(h * scale);
          const canvas = document.createElement("canvas");
          canvas.width = nw;
          canvas.height = nh;
          canvas.getContext("2d").drawImage(img, 0, 0, nw, nh);
          const resized = canvas.toDataURL("image/png");
          callback(resized.split(",")[1]);
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    }
    const imagePreviewEl = document.getElementById("image-preview");

    function renderImagePreview() {
      if (pendingImage) {
        imagePreviewEl.innerHTML = '<img src="data:' + pendingImage.mimeType + ';base64,' + pendingImage.data + '">'
          + '<button class="remove-img">Remove</button>';
        imagePreviewEl.classList.add("active");
        imagePreviewEl.querySelector(".remove-img").onclick = () => {
          pendingImage = null;
          renderImagePreview();
        };
      } else {
        imagePreviewEl.innerHTML = "";
        imagePreviewEl.classList.remove("active");
      }
    }

    sendInputEl.addEventListener("paste", (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) return;
          resizeImage(blob, MAX_IMAGE_SIZE, (base64) => {
            pendingImage = { data: base64, mimeType: "image/png" };
            renderImagePreview();
          });
          return;
        }
      }
    });

    let mentionActive = false;
    let mentionIndex = 0;
    let mentionFiltered = [];

    function setRecipient(value) {
      recipientTarget = value;
      recipientTagEl.innerHTML = value === "@all"
        ? "@all"
        : value + ' <span class="tag-remove">&times;</span>';
    }

    recipientTagEl.addEventListener("click", (e) => {
      if (e.target.classList.contains("tag-remove")) {
        setRecipient("@all");
      }
    });

    let popupMode = ""; // "mention" or "channel"

    function getPopupQuery() {
      const val = sendInputEl.value;
      const pos = sendInputEl.selectionStart;
      const before = val.slice(0, pos);
      const mentionMatch = before.match(/@([\\w-]*)$/);
      if (mentionMatch) return { mode: "mention", query: mentionMatch[1] };
      const channelMatch = before.match(/#([\\w-]*)$/);
      if (channelMatch) return { mode: "channel", query: channelMatch[1] };
      return null;
    }

    function getMentionCandidates() {
      const chInfo = channels.get(selectedChannel);
      const memberList = chInfo ? chInfo.members : [];
      const candidates = [];
      for (const [u] of users) {
        if (selectedChannel !== "#all" && memberList.length > 0 && !memberList.includes(u)) continue;
        candidates.push(u);
      }
      return candidates;
    }

    function getChannelCandidates() {
      return [...channels.keys()];
    }

    function showPopup() {
      const result = getPopupQuery();
      if (!result) { hidePopup(); return; }
      const candidates = result.mode === "mention" ? getMentionCandidates() : getChannelCandidates();
      mentionFiltered = candidates.filter(c => c.toLowerCase().startsWith((result.mode === "channel" ? "#" : "") + result.query.toLowerCase()));
      if (result.mode === "channel") mentionFiltered = mentionFiltered.map(c => c.replace(/^#/, ""));
      if (mentionFiltered.length === 0) { hidePopup(); return; }
      mentionIndex = 0;
      mentionActive = true;
      popupMode = result.mode;
      renderPopup();
    }

    function renderPopup() {
      const prefix = popupMode === "channel" ? "#" : "@";
      mentionPopupEl.innerHTML = "";
      mentionFiltered.forEach((name, i) => {
        const div = document.createElement("div");
        div.className = "mention-item" + (i === mentionIndex ? " active" : "");
        div.textContent = prefix + name;
        div.addEventListener("mouseenter", () => {
          mentionIndex = i;
          mentionPopupEl.querySelectorAll(".mention-item").forEach((el, j) => {
            el.classList.toggle("active", j === i);
          });
        });
        div.addEventListener("mousedown", (e) => { e.preventDefault(); selectPopupItem(name); });
        mentionPopupEl.appendChild(div);
      });
      mentionPopupEl.classList.add("visible");
    }

    function hidePopup() {
      mentionActive = false;
      mentionFiltered = [];
      popupMode = "";
      mentionPopupEl.classList.remove("visible");
    }

    function selectPopupItem(name) {
      const val = sendInputEl.value;
      const pos = sendInputEl.selectionStart;
      const before = val.slice(0, pos);
      const after = val.slice(pos);
      if (popupMode === "channel") {
        const replaced = before.replace(/#[\\w-]*$/, "#" + name + " ");
        sendInputEl.value = replaced + after;
        sendInputEl.selectionStart = sendInputEl.selectionEnd = replaced.length;
      } else {
        const replaced = before.replace(/@[\\w-]*$/, "");
        sendInputEl.value = replaced + after;
        sendInputEl.selectionStart = sendInputEl.selectionEnd = replaced.length;
        setRecipient("@" + name);
      }
      hidePopup();
      sendInputEl.focus();
    }

    function expectReply(name) {
      const prev = pendingReply.get(name);
      if (prev) clearTimeout(prev);
      pendingReply.set(name, setTimeout(() => {
        pendingReply.delete(name);
        if (users.has(name)) { users.set(name, false); renderUsers(); }
      }, 30000));
    }

    function clearPendingReply(name) {
      const timer = pendingReply.get(name);
      if (timer) { clearTimeout(timer); pendingReply.delete(name); }
    }

    function renderImageTag(image) {
      if (!image) return "";
      return '<div class="msg-image"><img src="data:' + image.mimeType + ';base64,' + image.data + '" onclick="window.open(this.src)"></div>';
    }

    function sendMessage() {
      const content = sendInputEl.value.trim();
      if (!content && !pendingImage) return;
      const channel = selectedChannel;
      const target = recipientTarget;
      const payload = { to: target, content, channel };
      if (pendingImage) payload.image = pendingImage;
      fetch("/admin-send", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify(payload),
      }).then(() => {
        sendInputEl.value = "";
        sendInputEl.style.height = "auto";
        pendingImage = null;
        renderImagePreview();
        sendInputEl.focus();
        // Start 30s reply expectation timer
        const targetName = target.startsWith("@") ? target.slice(1) : target;
        if (targetName === "all") {
          for (const [u] of users) { if (u !== "operator") expectReply(u); }
        } else {
          expectReply(targetName);
        }
      });
    }

    sendBtnEl.onclick = sendMessage;

    sendInputEl.addEventListener("keydown", (e) => {
      if (mentionActive && !e.isComposing) {
        if (e.key === "ArrowDown") { e.preventDefault(); mentionIndex = (mentionIndex + 1) % mentionFiltered.length; renderPopup(); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); mentionIndex = (mentionIndex - 1 + mentionFiltered.length) % mentionFiltered.length; renderPopup(); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); selectPopupItem(mentionFiltered[mentionIndex]); return; }
        if (e.key === "Escape") { e.preventDefault(); hidePopup(); return; }
      }
      if (e.isComposing) return;
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey) { e.preventDefault(); sendMessage(); }
    });

    sendInputEl.addEventListener("input", () => {
      sendInputEl.style.height = "auto";
      sendInputEl.style.height = Math.min(sendInputEl.scrollHeight, 120) + "px";
      sendInputEl.style.overflowY = sendInputEl.scrollHeight > 120 ? "auto" : "hidden";
      showPopup();
    });

    sendInputEl.addEventListener("blur", () => {
      setTimeout(() => hidePopup(), 150);
    });

    // Filter toggle
    const filterBtn = document.getElementById("filter-btn");
    filterBtn.onclick = () => {
      document.body.classList.toggle("filter-operator");
      filterBtn.classList.toggle("active");
    };

    // Clear button
    document.getElementById("clear-btn").onclick = () => {
      messagesEl.innerHTML = '<div class="empty">Waiting for transmissions...</div>';
    };

    const AGENT_NAME_RE = /^[a-zA-Z0-9_-]+$/;
    const agentDialogEl = document.getElementById("agent-dialog");
    const agentDialogTitle = document.getElementById("agent-dialog-title");
    const agentDialogId = document.getElementById("agent-dialog-id");
    const agentDialogName = document.getElementById("agent-dialog-name");
    const agentDialogNameError = document.getElementById("agent-dialog-name-error");
    const agentDialogWorkdir = document.getElementById("agent-dialog-workdir");
    const agentDialogAutostart = document.getElementById("agent-dialog-autostart");

    function updateCommandPreview() {
      const name = agentDialogName.value.trim();
      if (name && AGENT_NAME_RE.test(name)) {
        agentDialogNameError.style.display = "none";
      } else if (name) {
        agentDialogNameError.textContent = "Use only a-z, 0-9, hyphen, underscore";
        agentDialogNameError.style.display = "block";
      } else {
        agentDialogNameError.style.display = "none";
      }
    }

    agentDialogName.addEventListener("input", updateCommandPreview);

    function openAgentDialog(id, agent) {
      const isEdit = !!id;
      agentDialogTitle.textContent = isEdit ? "Edit Agent" : "New Agent";
      agentDialogId.value = id || "";
      agentDialogName.value = agent ? agent.name : "";
      agentDialogWorkdir.value = agent ? agent.workDir : "";
      agentDialogAutostart.checked = agent ? agent.autoStart : false;
      updateCommandPreview();
      agentDialogEl.style.display = "flex";
      agentDialogName.focus();
    }

    function closeAgentDialog() {
      agentDialogEl.style.display = "none";
    }

    // --- Build identity ---------------------------------------------------------------
    // Shows the release the build is based on plus how long this process has been up. Uptime
    // is the part that actually answers "is this the build I just deployed?" — a hub that
    // started a minute ago is the one you just pushed — and it needs no build-time plumbing.
    // The short revision appears only when the deploy supplied WALKIE_TALKIE_BUILD_REV.
    const buildChipEl = document.getElementById("build-chip");
    function renderBuildChip() {
      const up = shortDuration(Date.now() - BUILD.startedAt);
      buildChipEl.textContent = "v" + BUILD.version + (BUILD.buildRev ? " \u00b7 " + BUILD.buildRev : "");
      // NB: this file is one big TS template literal, so an escape written as a single
      // backslash is resolved HERE and emitted as a real character. A "\\n" is required to put
      // the two characters \\n into the page for the browser's parser; a single one emitted a
      // literal newline inside a JS string literal and broke the whole script.
      const NL = String.fromCharCode(10);
      buildChipEl.title =
        "Hub v" + BUILD.version
        + (BUILD.buildRev ? NL + "build " + BUILD.buildRev : NL + "build revision not supplied by the deploy")
        + NL + "up " + up + " (started " + new Date(BUILD.startedAt).toLocaleString() + ")"
        + NL + "This deployment runs upstream " + BUILD.version + " plus local patches, so the"
        + " version is a base, not an identity — use the uptime or revision to tell builds apart.";
    }
    renderBuildChip();
    // Cheap: only rewrites a tooltip, and keeps the uptime honest on a long-lived tab.
    setInterval(renderBuildChip, 30_000);

    // --- Connect modal: how to install the MCP server on another machine ---------------
    // The installer is a sibling service on the same host, one port over, so the base URL is
    // derived from wherever the operator loaded this dashboard. That is correct by
    // construction for a direct connection. WALKIE_TALKIE_INSTALLER_URL overrides it for the
    // case where the hub is reached through a proxy that does not also front the installer.
    const INSTALLER_PORT = "9558";
    const installerBase = INSTALLER_URL || (location.protocol + "//" + location.hostname + ":" + INSTALLER_PORT);
    const connectDialogEl = document.getElementById("connect-dialog");

    document.getElementById("connect-sh").textContent =
      "curl -fsSL " + installerBase + "/install.sh | bash";
    document.getElementById("connect-ps").textContent =
      "irm " + installerBase + "/install.ps1 | iex";
    // Same installer, rendered for the gemini CLI — see installer/render.sh on the hub host.
    document.getElementById("connect-ps-gemini").textContent =
      "irm " + installerBase + "/install-gemini.ps1 | iex";

    // Mint an enrollment code for one callsign. The hub returns the CODE, never the key: the key
    // is minted at redemption and shown only to the machine that redeems it, so the secret never
    // reaches this browser and there is nothing here to leak or to have to recover.
    const mintCallsignEl = document.getElementById("mint-callsign");
    const mintBtnEl = document.getElementById("mint-btn");
    const mintStatusEl = document.getElementById("mint-status");
    const mintCodeRowEl = document.getElementById("mint-code-row");
    const mintCodeEl = document.getElementById("mint-code");

    async function mintEnrollmentCode() {
      const callsign = mintCallsignEl.value.trim();
      mintStatusEl.classList.remove("mint-error");
      if (!callsign) {
        mintStatusEl.textContent = "Enter a callsign first.";
        mintStatusEl.classList.add("mint-error");
        return;
      }
      mintBtnEl.disabled = true;
      mintStatusEl.textContent = "Minting...";
      mintCodeRowEl.style.display = "none";
      try {
        const r = await fetch("/admin-station-key-create", {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({ callsign: callsign }),
        });
        const data = await r.json();
        if (!r.ok) {
          mintStatusEl.textContent = data.error || "Mint failed.";
          mintStatusEl.classList.add("mint-error");
          return;
        }
        mintCodeEl.textContent = data.code;
        mintCodeRowEl.style.display = "flex";
        mintStatusEl.textContent =
          "Code for " + data.callsign + " (role " + data.role + "), valid for "
          + data.ttlMinutes + " minutes. Single use.";
      } catch (e) {
        mintStatusEl.textContent = "Mint failed: " + e.message;
        mintStatusEl.classList.add("mint-error");
      } finally {
        mintBtnEl.disabled = false;
      }
    }
    mintBtnEl.onclick = mintEnrollmentCode;
    mintCallsignEl.onkeydown = (e) => { if (e.key === "Enter") mintEnrollmentCode(); };

    function openConnectDialog() { connectDialogEl.style.display = "flex"; }
    function closeConnectDialog() { connectDialogEl.style.display = "none"; }
    document.getElementById("connect-btn").onclick = openConnectDialog;
    document.getElementById("connect-dialog-close").onclick = closeConnectDialog;
    connectDialogEl.onclick = (e) => { if (e.target === connectDialogEl) closeConnectDialog(); };
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && connectDialogEl.style.display !== "none") closeConnectDialog();
    });

    for (const btn of document.querySelectorAll(".copy-btn")) {
      btn.onclick = () => {
        const text = document.getElementById(btn.dataset.copy).textContent;
        // navigator.clipboard needs a secure context; this dashboard is plain http over a
        // tailnet, so fall back to a hidden textarea + execCommand rather than silently failing.
        const done = () => {
          btn.textContent = "Copied";
          btn.classList.add("copied");
          setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1400);
        };
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
        } else {
          fallbackCopy(text, done);
        }
      };
    }
    function fallbackCopy(text, done) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (_) { /* leave it selectable */ }
      document.body.removeChild(ta);
    }

    document.getElementById("agent-dialog-cancel").onclick = closeAgentDialog;
    agentDialogEl.onclick = (e) => { if (e.target === agentDialogEl) closeAgentDialog(); };

    document.getElementById("agent-dialog-save").onclick = () => {
      const id = agentDialogId.value;
      const name = agentDialogName.value.trim();
      const workDir = agentDialogWorkdir.value.trim();
      const autoStart = agentDialogAutostart.checked;
      if (!name || !AGENT_NAME_RE.test(name)) { agentDialogName.focus(); updateCommandPreview(); return; }
      if (!workDir) { agentDialogWorkdir.focus(); return; }
      if (id) {
        fetch("/admin-agent-config-update", {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({ id, name, workDir, autoStart }),
        }).then(r => r.json()).then(data => {
          if (data.error) alert(data.error);
          else closeAgentDialog();
        }).catch(() => {});
      } else {
        fetch("/admin-agent-config-create", {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({ name, workDir }),
        }).then(r => r.json()).then(data => {
          if (data.error) alert(data.error);
          else closeAgentDialog();
        }).catch(() => {});
      }
    };

    document.getElementById("add-agent-btn").onclick = () => openAgentDialog(null, null);

    document.getElementById("add-channel-btn").onclick = () => {
      const name = prompt("Channel name (without #):");
      if (!name || !name.trim()) return;
      fetch("/admin-channel-create", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ name: name.trim() }),
      }).then(r => r.json()).then(data => {
        if (data.error) alert(data.error);
      }).catch(() => {});
    };

    function deleteChannel(name) {
      fetch("/admin-channel-delete", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ name }),
      }).then(r => r.json()).then(data => {
        if (data.error) alert(data.error);
      }).catch(() => {});
    }

    // Fetch initial data. /users is the only source of hasActivePoll/lastSeen — SSE carries
    // only online — so it is re-polled on an interval to keep the stale indicator honest
    // rather than frozen at page-load state.
    function refreshUsers() {
      return fetch("/users").then(r => r.json()).then(data => {
        const now = Date.now();
        const seen = new Set();
        for (const u of data.users) {
          seen.add(u.name);
          users.set(u.name, u.online);
          const prev = liveness.get(u.name);
          liveness.set(u.name, {
            hasActivePoll: u.hasActivePoll,
            lastSeen: u.lastSeen ?? null,
            // Keep the first observation so a user that has never polled still ages from a
            // fixed point instead of resetting its grace on every refresh.
            firstSeen: prev ? prev.firstSeen : now,
          });
        }
        for (const name of liveness.keys()) if (!seen.has(name)) liveness.delete(name);
        renderUsers();
      }).catch(() => {});
    }
    refreshUsers();
    setInterval(refreshUsers, USERS_REFRESH_MS);

    fetch("/channels").then(r => r.json()).then(data => {
      for (const ch of data.channels) {
        channels.set(ch.name, { memberCount: ch.memberCount, createdBy: ch.createdBy, members: ch.members || [] });
      }
      renderChannels();
      updateChannelHeader();
    }).catch(() => {});

    // Load agent configs
    refreshAgentConfigs();

    // Load unread counts
    fetch("/admin-unread-counts", { headers: { "Authorization": "Bearer " + ADMIN_TOKEN } })
      .then(r => r.json())
      .then(data => {
        if (data.counts) {
          for (const [ch, cnt] of Object.entries(data.counts)) {
            unreadCounts[ch] = cnt;
          }
          renderChannels();
        }
      }).catch(() => {});

    // Load message history from DB
    fetch("/admin-channel-history", { headers: { "Authorization": "Bearer " + ADMIN_TOKEN } })
      .then(r => r.json())
      .then(data => {
        if (data.messages && data.messages.length > 0) {
          clearEmpty();
          for (const msg of data.messages) {
            const cls = msg.from === "operator" ? "message operator" : msg.from === "wall" ? "message wall" : "message";
            const channelTag = '<span class="channel-tag">' + (msg.channel || "#all") + '</span>';
            addMessage(
              '<span class="time">' + formatTime(msg.timestamp) + '</span>' +
              channelTag +
              '<span class="from">' + msg.from + '</span> ' +
              '<span class="to">&rarr; ' + msg.to + '</span>' +
              '<div class="content">' + msg.content.replace(/</g, "&lt;") + '</div>' +
              renderImageTag(msg.image),
              cls,
              msg.channel || "#all"
            );
          }
        }
        // Mark #all as read after loading history
        markChannelRead("#all");
      }).catch(() => {});

    const es = new EventSource("/events");

    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);

      if (ev.type === "status") {
        if (users.has(ev.name)) {
          users.set(ev.name, ev.online);
          renderUsers();
          renderAgents();
        }
      } else if (ev.type === "join") {
        users.set(ev.name, true);
        renderUsers();
        renderAgents();
        refreshChannels();
        addMessage(
          '<span class="time">' + formatTime(ev.timestamp) + '</span>' +
          '<strong>' + ev.name + '</strong> joined the channel',
          "system",
          null
        );
      } else if (ev.type === "leave") {
        users.delete(ev.name);
        renderUsers();
        renderAgents();
        refreshChannels();
        addMessage(
          '<span class="time">' + formatTime(ev.timestamp) + '</span>' +
          '<strong>' + ev.name + '</strong> left the channel',
          "system leave",
          null
        );
      } else if (ev.type === "message") {
        // Clear typing and pending-reply state when user sends a real message
        clearPendingReply(ev.from);
        if (users.has(ev.from)) users.set(ev.from, true);
        const existingTimer = typingUsers.get(ev.from);
        if (existingTimer) { clearTimeout(existingTimer.timeoutId); typingUsers.delete(ev.from); renderUsers(); renderTypingBar(); }
        const cls = ev.from === "operator" ? "message operator" : ev.from === "wall" ? "message wall" : "message";
        const channelTag = '<span class="channel-tag">' + (ev.channel || "#all") + '</span>';
        addMessage(
          '<span class="time">' + formatTime(ev.timestamp) + '</span>' +
          channelTag +
          '<span class="from">' + ev.from + '</span> ' +
          '<span class="to">&rarr; ' + ev.to + '</span>' +
          '<div class="content">' + ev.content.replace(/</g, "&lt;") + '</div>' +
          renderImageTag(ev.image),
          cls,
          ev.channel || "#all"
        );
        // Unread tracking
        const msgChannel = ev.channel || "#all";
        if (msgChannel === selectedChannel) {
          markChannelRead(msgChannel);
        } else {
          unreadCounts[msgChannel] = (unreadCounts[msgChannel] || 0) + 1;
          renderChannels();
        }
      } else if (ev.type === "channel_create") {
        refreshChannels();
        addMessage(
          '<span class="time">' + formatTime(ev.timestamp) + '</span>' +
          'Channel <strong>' + ev.name + '</strong> created',
          "system channel-event",
          null
        );
      } else if (ev.type === "channel_join") {
        refreshChannels();
        addMessage(
          '<span class="time">' + formatTime(ev.timestamp) + '</span>' +
          '<strong>' + ev.userName + '</strong> joined <strong>' + ev.channel + '</strong>',
          "system channel-event",
          ev.channel
        );
      } else if (ev.type === "channel_leave") {
        refreshChannels();
        addMessage(
          '<span class="time">' + formatTime(ev.timestamp) + '</span>' +
          '<strong>' + ev.userName + '</strong> left <strong>' + ev.channel + '</strong>',
          "system channel-event leave",
          ev.channel
        );
      } else if (ev.type === "read_update") {
        if (ev.userName === "operator") {
          delete unreadCounts[ev.channel];
          renderChannels();
        }
      } else if (ev.type === "channel_delete") {
        if (selectedChannel === ev.name) selectedChannel = "#all";
        delete unreadCounts[ev.name];
        refreshChannels();
        addMessage(
          '<span class="time">' + formatTime(ev.timestamp) + '</span>' +
          'Channel <strong>' + ev.name + '</strong> deleted',
          "system channel-event leave",
          null
        );
      } else if (ev.type === "agent_config_create" || ev.type === "agent_config_update") {
        refreshAgentConfigs();
      } else if (ev.type === "agent_config_delete") {
        agentConfigs.delete(ev.id);
        renderAgents();
      } else if (ev.type === "typing") {
        clearPendingReply(ev.name);
        if (users.has(ev.name)) users.set(ev.name, true);
        const prev = typingUsers.get(ev.name);
        if (prev) clearTimeout(prev.timeoutId);
        typingUsers.set(ev.name, { timeoutId: setTimeout(() => { typingUsers.delete(ev.name); renderUsers(); renderTypingBar(); }, 60000), channel: ev.channel || "#all" });
        renderUsers();
        renderTypingBar();
      }
    };

    es.onopen = () => {
      statusEl.textContent = "connected";
      statusEl.className = "";
    };

    es.onerror = () => {
      statusEl.textContent = "disconnected";
      statusEl.className = "disconnected";
    };

    // Mobile sidebar drawer toggle
    const sidebarEl = document.getElementById("sidebar");
    const sidebarBackdrop = document.getElementById("sidebar-backdrop");
    function setSidebar(open) {
      sidebarEl.classList.toggle("open", open);
      sidebarBackdrop.classList.toggle("open", open);
    }
    document.getElementById("menu-toggle").addEventListener("click", () => {
      setSidebar(!sidebarEl.classList.contains("open"));
    });
    sidebarBackdrop.addEventListener("click", () => setSidebar(false));
    // Close the drawer after selecting a channel
    channelListEl.addEventListener("click", () => setSidebar(false));
  </script>
</body>
</html>`;
}
