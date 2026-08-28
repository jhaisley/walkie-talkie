import http from "node:http";
import https from "node:https";

interface RequestOptions {
  method: string;
  path: string;
  token?: string;
  body?: unknown;
  timeoutMs?: number;
}

interface HubResponse<T = unknown> {
  status: number;
  data: T;
}

/**
 * How long radio_standby waits on an empty channel (WALKIE_TALKIE_POLL_WAIT_MS, default 30s),
 * and the ceiling an agent may request per call (WALKIE_TALKIE_MAX_POLL_WAIT_MS, default 30s so
 * an install that has not opted in cannot be pushed past what its host tolerates).
 *
 * These are per-CLIENT values because the binding constraint is the MCP client's tool-call
 * timeout: exceed it and the whole MCP server is dropped as unresponsive. Claude Code tolerates
 * a long call; other CLIs default far lower. The installer sets both to match the CLI it is
 * installing for, which is why the defaults here stay conservative.
 *
 * This is the main lever on idle cost — every empty return is a model turn, so a 30s window
 * costs ~120 turns per station per hour and a 20min window ~3. It does NOT affect delivery
 * latency: the hub answers a pending poll the moment a message is routed, so the window only
 * bounds how long an EMPTY wait lasts.
 */
const DEFAULT_POLL_WAIT_MS = 30_000;
const DEFAULT_MAX_POLL_WAIT_MS = 30_000;
/** Head-start the hub is asked to answer within, so it always replies before we abort. */
const HUB_MARGIN_MS = 5_000;

function envMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolvePollWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs(env.WALKIE_TALKIE_POLL_WAIT_MS, DEFAULT_POLL_WAIT_MS);
}

export function resolveMaxPollWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  // The ceiling can never be below the configured default, or the default would be unreachable.
  return Math.max(envMs(env.WALKIE_TALKIE_MAX_POLL_WAIT_MS, DEFAULT_MAX_POLL_WAIT_MS), resolvePollWaitMs(env));
}

/**
 * Clamp an agent-requested standby window. Anything unusable falls back to the configured
 * default rather than erroring: a bad number should not cost the station its listening turn.
 */
export function clampPollWaitMs(requestedMs: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  if (requestedMs === undefined || !Number.isFinite(requestedMs) || requestedMs <= 0) {
    return resolvePollWaitMs(env);
  }
  return Math.min(Math.max(requestedMs, 1_000), resolveMaxPollWaitMs(env));
}

export class HubClient {
  private baseUrl: URL;

  constructor(hubUrl: string) {
    this.baseUrl = new URL(hubUrl);
  }

  getBaseUrl(): string {
    return this.baseUrl.toString().replace(/\/$/, "");
  }

  private request<T>(options: RequestOptions): Promise<HubResponse<T>> {
    return new Promise((resolve, reject) => {
      const isHttps = this.baseUrl.protocol === "https:";
      const transport = isHttps ? https : http;

      const headers: Record<string, string> = {};
      if (options.token) {
        headers.Authorization = `Bearer ${options.token}`;
      }

      let bodyStr: string | undefined;
      if (options.body !== undefined) {
        bodyStr = JSON.stringify(options.body);
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(bodyStr).toString();
      }

      const req = transport.request(
        {
          hostname: this.baseUrl.hostname,
          port: this.baseUrl.port,
          path: options.path,
          method: options.method,
          headers,
          timeout: options.timeoutMs ?? 10_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString();
            const status = res.statusCode ?? 0;
            if (status === 204 || raw.length === 0) {
              resolve({ status, data: {} as T });
              return;
            }
            try {
              resolve({ status, data: JSON.parse(raw) as T });
            } catch {
              reject(new Error(`Invalid JSON response: ${raw}`));
            }
          });
        },
      );

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timed out"));
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async register(
    name: string,
    joinToken: string,
    oldToken?: string,
  ): Promise<{ token: string; name: string; reclaimed?: boolean }> {
    const body: { name: string; oldToken?: string } = { name };
    if (oldToken) body.oldToken = oldToken;
    const res = await this.request<{ token: string; name: string; reclaimed?: boolean }>({
      method: "POST",
      path: "/register",
      token: joinToken,
      body,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Registration failed");
    }
    return res.data;
  }

  async unregister(token: string): Promise<void> {
    await this.request({
      method: "POST",
      path: "/unregister",
      token,
    });
  }

  async send(
    token: string,
    to: string,
    content: string,
    channel?: string,
    image?: { data: string; mimeType: string },
  ): Promise<{ id: string; to: string }> {
    const body: { to: string; content: string; channel?: string; image?: { data: string; mimeType: string } } = {
      to,
      content,
    };
    if (channel) body.channel = channel;
    if (image) body.image = image;
    const res = await this.request<{ id: string; to: string }>({
      method: "POST",
      path: "/send",
      token,
      body,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Send failed");
    }
    return res.data;
  }

  /**
   * Bounded long-poll for radio_standby. timeoutMs MUST stay well under the MCP
   * client's tool-call timeout: this runs as an MCP tool, and if the call blocks
   * longer than that timeout the whole MCP server is dropped as unresponsive
   * ("No such tool available"). 30s matches the tool's documented "blocks up to
   * 30 seconds" and stays under the default 60s MCP timeout.
   *
   * It is also the ceiling for the hub's own idle-poll timeout, which MUST stay
   * strictly below this value (see resolvePollTimeoutMs in hub/src/polling.ts).
   * Whichever side ends an idle poll first decides how it reads: hub-first is a
   * clean 204, client-first is a socket abort the hub scores as a crashed agent.
   * If you raise this, raise the hub's timeout to match -- never the reverse.
   *
   * A timeout with no message is the NORMAL "no messages" outcome, not an error,
   * so we resolve it to null (radio_standby then reports "no new messages")
   * rather than throwing — throwing would surface as a tool error / dropped call.
   */
  async poll(
    token: string,
    timeoutMs = resolvePollWaitMs(),
  ): Promise<{
    messages: Array<{
      id: string;
      from: string;
      to: string;
      content: string;
      channel: string;
      timestamp: number;
      image?: { data: string; mimeType: string };
    }>;
  } | null> {
    try {
      const res = await this.request<{
        messages: Array<{
          id: string;
          from: string;
          to: string;
          content: string;
          channel: string;
          timestamp: number;
          image?: { data: string; mimeType: string };
        }>;
      }>({
        method: "GET",
        // Ask the hub for a window HUB_MARGIN_MS shorter than our own abort. The hub answering
        // first is what keeps an idle poll from looking like a dropped connection: a
        // client-side abort fires the hub's disconnect path, which marks the station offline
        // and arms the stale-registration grace that reaped idle stations across the fleet.
        path: `/poll?wait=${Math.max(1_000, timeoutMs - HUB_MARGIN_MS)}`,
        token,
        timeoutMs,
      });
      if (res.status === 204) return null;
      if (res.status !== 200) {
        throw new Error((res.data as { error?: string }).error ?? "Poll failed");
      }
      return res.data;
    } catch (e) {
      if (e instanceof Error && e.message === "Request timed out") return null;
      throw e;
    }
  }

  async inbox(token: string): Promise<{
    messages: Array<{
      id: string;
      from: string;
      to: string;
      content: string;
      channel: string;
      timestamp: number;
      image?: { data: string; mimeType: string };
    }>;
  }> {
    const res = await this.request<{
      messages: Array<{
        id: string;
        from: string;
        to: string;
        content: string;
        channel: string;
        timestamp: number;
        image?: { data: string; mimeType: string };
      }>;
    }>({
      method: "GET",
      path: "/inbox",
      token,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Inbox fetch failed");
    }
    return res.data;
  }

  async users(token: string): Promise<Array<{ name: string; online: boolean; role: string }>> {
    // The hub's GET /users returns objects, not bare strings — see hub handleUsers +
    // its api-register/api-admin tests. The prior `string[]` typing was wrong and
    // caused callers to render "[object Object]" when joining the array.
    //
    // The hub also returns lastSeen/hasActivePoll per user. They are deliberately not
    // declared here: no mcp-server caller reads them, and widening this type would
    // oblige every consumer to handle fields it does not use. Structural typing means
    // the extra fields pass through harmlessly. If a tool ever needs them, widen here
    // rather than casting at the call site.
    const res = await this.request<{ users: Array<{ name: string; online: boolean; role: string }> }>({
      method: "GET",
      path: "/users",
      token,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Failed to get users");
    }
    return res.data.users;
  }

  async listChannels(token: string): Promise<Array<{ name: string; memberCount: number; createdBy: string }>> {
    const res = await this.request<{ channels: Array<{ name: string; memberCount: number; createdBy: string }> }>({
      method: "GET",
      path: "/channels",
      token,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Failed to list channels");
    }
    return res.data.channels;
  }

  async createChannel(token: string, name: string): Promise<{ channel: string }> {
    const res = await this.request<{ ok: boolean; channel: string }>({
      method: "POST",
      path: "/channel-create",
      token,
      body: { name },
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Failed to create channel");
    }
    return { channel: res.data.channel };
  }

  async joinChannel(token: string, channel: string): Promise<void> {
    const res = await this.request({
      method: "POST",
      path: "/channel-join",
      token,
      body: { channel },
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Failed to join channel");
    }
  }

  async leaveChannel(token: string, channel: string): Promise<void> {
    const res = await this.request({
      method: "POST",
      path: "/channel-leave",
      token,
      body: { channel },
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Failed to leave channel");
    }
  }

  async inviteToChannel(token: string, channel: string, user: string): Promise<void> {
    const res = await this.request({
      method: "POST",
      path: "/channel-invite",
      token,
      body: { channel, user },
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Failed to invite user to channel");
    }
  }
}
