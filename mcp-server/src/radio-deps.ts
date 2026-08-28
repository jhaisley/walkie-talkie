/**
 * Everything a set of radio tools needs from its host, as data rather than module state.
 *
 * The tools used to close over four module globals (`client`, `joinToken`, `currentToken`,
 * `currentName`). That was only safe because a station ran its own stdio process: one server,
 * one set of globals, one callsign. Calling `createMcpServer` twice in one process already
 * clobbered the first server's hub client, so the globals were not merely "unsafe for many
 * stations" — they were a latent bug that a hub-hosted (remote) transport turns into a
 * guaranteed one, because a remote server serves every station from a single process.
 *
 * Passing a `RadioDeps` per MCP server instance makes the per-session state explicit and lets
 * the same tool definitions run over two very different transports:
 *
 *   - stdio, on the station's own machine, where reading a local file is exactly what the
 *     operator asked for; and
 *   - Streamable HTTP, hosted by the hub, where reading a local file would read the HUB's disk.
 *
 * The optional capability functions are the seam. `undefined` means "this transport cannot do
 * it", and the tool says so instead of silently doing the wrong thing on the wrong machine.
 */

/** Mutable, per-session registration state. One object per MCP server instance. */
export interface RadioSession {
  /** The hub session token minted by radio_join, or null when not on the air. */
  token: string | null;
  /** The callsign the hub granted, or null when not on the air. */
  name: string | null;
}

/** Durable store for the session token. File-backed on stdio; a no-op on the hub. */
export interface RadioTokenStore {
  read(hubUrl: string, name: string): string | null;
  write(hubUrl: string, name: string, token: string): void;
  clear(hubUrl: string, name: string): void;
}

export interface RadioMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  channel: string;
  timestamp: number;
  image?: { data: string; mimeType: string };
}

/**
 * The hub operations the tools need, as an interface rather than the concrete HTTP `HubClient`.
 *
 * `HubClient` satisfies this structurally, so the stdio path is unchanged. The hub-hosted path
 * supplies an in-process implementation instead: looping HTTP back to 127.0.0.1 would double
 * the sockets and re-run auth to reach functions already in the same process.
 */
export interface RadioHubClient {
  getBaseUrl(): string;
  register(
    name: string,
    joinToken: string,
    oldToken?: string,
  ): Promise<{ token: string; name: string; reclaimed?: boolean }>;
  unregister(token: string): Promise<void>;
  send(
    token: string,
    to: string,
    content: string,
    channel?: string,
    image?: { data: string; mimeType: string },
  ): Promise<{ id: string; to: string }>;
  /**
   * Long-poll for messages. Resolves null for "nothing arrived in the window", which is the
   * NORMAL idle outcome and must not be an error.
   *
   * `signal` is the MCP request's abort signal. The in-process implementation uses it to stop
   * waiting when a tool call is cancelled; the HTTP implementation ignores it, because on stdio
   * the socket timeout already bounds the call and aborting the socket early is precisely what
   * makes the hub score an idle station as a crashed one.
   */
  poll(token: string, timeoutMs?: number, signal?: AbortSignal): Promise<{ messages: RadioMessage[] } | null>;
  inbox(token: string): Promise<{ messages: RadioMessage[] }>;
  users(token: string): Promise<Array<{ name: string; online: boolean; role: string }>>;
  listChannels(token: string): Promise<Array<{ name: string; memberCount: number; createdBy: string }>>;
  createChannel(token: string, name: string): Promise<{ channel: string }>;
  joinChannel(token: string, channel: string): Promise<void>;
  leaveChannel(token: string, channel: string): Promise<void>;
  inviteToChannel(token: string, channel: string, user: string): Promise<void>;
}

export interface RadioDeps {
  /** Hub operations for this session. */
  client: RadioHubClient;
  /** The shared join token presented at radio_join. */
  joinToken: string;
  /** Per-session registration state. MUST be a distinct object per MCP server instance. */
  session: RadioSession;
  /**
   * Identifier for the code serving this station, reported in radio_join's `[client …]` marker
   * and by radio_token. `"1.7.0+abc123"` for an installed bundle, `"hub-1.7.0+abc123"` when the
   * hub serves the tools itself. Fleet tooling reads this marker, so it is a contract.
   */
  clientBuildLabel: string;
  /**
   * Clamp an agent-requested radio_standby window (ms) to what this transport can hold open.
   *
   * A dep rather than a shared helper because the binding constraint lives on a different side
   * of the wire for each transport. On stdio it is the STATION's MCP tool-call timeout, read
   * from the station's own env (WALKIE_TALKIE_MAX_POLL_WAIT_MS). On the hub it is the hub's own
   * ceiling (WALKIE_TALKIE_MAX_POLL_WINDOW_MS, 15 min), because a remote station's request never
   * touches the station's env at all — reusing the stdio clamp there would silently cap every
   * remote standby at the 30s stdio default and reinstate the idle-turn cost the long window exists
   * to remove.
   */
  clampStandbyMs(requestedMs: number | undefined): number;

  /**
   * Read a file from the machine the tools are running on. Present only on stdio, where that
   * machine is the station's own. Absent on the hub, where it would be an arbitrary file read
   * on the container host by any holder of the shared join token.
   */
  readLocalFile?: (source: string) => Buffer;
  /**
   * Fetch an http(s) URL. Present on stdio (the station's own network). Absent on the hub by
   * default, where it would be a request forger sitting inside the internal network.
   */
  fetchRemoteUrl?: (url: string) => Promise<Buffer>;
  /**
   * Locate the shell listener script on this station's disk. Absent on the hub: a hub-side
   * script would be useless to the station, so "not installed here" is the honest answer and
   * the note radio_token emits differs accordingly.
   */
  waitScriptPath?: () => string | null;

  tokenStore: RadioTokenStore;
}

/** A token store that keeps nothing. The hub holds the session token in memory already. */
export const nullTokenStore: RadioTokenStore = {
  read: () => null,
  write: () => {},
  clear: () => {},
};
