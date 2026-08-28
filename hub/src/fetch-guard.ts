import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Outbound HTTP for the hub-hosted radio, when an operator has explicitly opted in.
 *
 * `radio_send_image` accepts an http(s) source. On a locally-installed radio that fetch happens
 * on the station's own machine and the blast radius is the operator's own network. Hosted by the
 * hub it is something else entirely: a request forger sitting INSIDE the internal network,
 * driven by anyone holding the shared join token. On this deployment that reaches the GCP
 * metadata server (169.254.169.254), the shared Cloud SQL proxy, the Prefect server and the
 * proxy manager's admin port — all inside a HIPAA boundary.
 *
 * So it is off unless BOTH are set:
 *   WALKIE_TALKIE_MCP_ALLOW_REMOTE_FETCH=1
 *   WALKIE_TALKIE_MCP_FETCH_ALLOW_HOSTS=cdn.example.com,images.example.org
 *
 * An opt-in with no allowlist stays off on purpose: "allow fetching, from anywhere" is the
 * configuration nobody means to write, and it is the one that hands over the metadata server.
 *
 * Two independent gates, because either alone is defeatable:
 *   - the host allowlist stops an attacker naming an internal service outright; and
 *   - an address check on the RESOLVED ip stops the same attack laundered through a public
 *     hostname whose A record points at 169.254.169.254 or 10.0.0.x.
 *
 * Both are re-applied on every redirect hop. The stdio fetcher follows redirects blindly, which
 * is why this is a separate implementation rather than a shared one: a pre-flight-only check is
 * no check at all against a 302.
 */

const MAX_REDIRECTS = 5;
/** Cap on a fetched image. It is about to be base64'd into a message and held in memory. */
const MAX_BYTES = 8 * 1024 * 1024;

function isEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.WALKIE_TALKIE_MCP_ALLOW_REMOTE_FETCH ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function parseAllowHosts(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0),
  );
}

/**
 * Whether an IP literal must never be connected to. Covers loopback, link-local (which is where
 * the cloud metadata server lives), the RFC1918 ranges the internal Docker networks use,
 * carrier-grade NAT, unspecified, multicast, and the IPv6 equivalents including v4-mapped forms.
 */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return true; // not an IP at all — refuse rather than guess

  if (family === 4) {
    const o = address.split(".").map(Number);
    if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    if (o[0] === 0) return true; // "this network" / unspecified
    if (o[0] === 10) return true; // RFC1918
    if (o[0] === 127) return true; // loopback
    if (o[0] === 169 && o[1] === 254) return true; // link-local — GCP/AWS metadata
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // RFC1918
    if (o[0] === 192 && o[1] === 168) return true; // RFC1918
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT (Tailscale)
    if (o[0] >= 224) return true; // multicast + reserved
    return false;
  }

  const v6 = address.toLowerCase().split("%")[0];
  if (v6 === "::" || v6 === "::1") return true;
  // v4-mapped / v4-compatible: judge by the embedded v4 address.
  const mapped = /^::(ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isBlockedAddress(mapped[2]);
  if (v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb")) return true; // link-local
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // unique-local
  if (v6.startsWith("ff")) return true; // multicast
  return false;
}

/**
 * A dns.lookup replacement that refuses to hand back a blocked address.
 *
 * Passed to http.request as `lookup`, so the address that is VALIDATED is the same one that is
 * CONNECTED to. Validating separately and then letting the agent resolve again would leave a
 * DNS-rebinding window between the two lookups.
 */
// dns.lookup's overloads are keyed on a literal `all`, which a pass-through wrapper cannot know
// statically; this alias states the union both branches actually produce.
const dnsLookupAny = dns.lookup as unknown as (
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
) => void;

const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dnsLookupAny(hostname, options, (err, address, family) => {
    if (err) {
      callback(err, address as string, family);
      return;
    }
    const resolved = Array.isArray(address) ? address.map((a) => a.address) : [address];
    const bad = resolved.find(isBlockedAddress);
    if (bad !== undefined) {
      const blocked: NodeJS.ErrnoException = new Error(
        `refusing to connect to ${hostname}: resolves to a private or link-local address (${bad})`,
      );
      blocked.code = "EACCES";
      callback(blocked, "", 0);
      return;
    }
    callback(null, address as string, family);
  });
};

function fetchOnce(url: URL, allowHosts: Set<string>, hop: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (hop > MAX_REDIRECTS) return reject(new Error("too many redirects"));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return reject(new Error(`unsupported protocol ${url.protocol}`));
    }
    // Re-applied per hop, not just on the URL the caller supplied.
    if (!allowHosts.has(url.hostname.toLowerCase())) {
      return reject(new Error(`host "${url.hostname}" is not in this hub's fetch allowlist`));
    }

    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        lookup: guardedLookup,
        timeout: 15_000,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume(); // drain, or the socket is held open
          let next: URL;
          try {
            next = new URL(res.headers.location, url);
          } catch {
            return reject(new Error("redirect to an unparseable location"));
          }
          fetchOnce(next, allowHosts, hop + 1).then(resolve, reject);
          return;
        }
        if (status >= 400) {
          res.resume();
          return reject(new Error(`HTTP ${status}`));
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_BYTES) {
            req.destroy();
            reject(new Error(`response exceeds ${MAX_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("request timed out"));
    });
    req.end();
  });
}

/**
 * The `fetchRemoteUrl` capability for hub-hosted radio deps, or undefined when the operator has
 * not opted in — which is the default, and which makes radio_send_image answer with actionable
 * guidance instead of turning the hub into a proxy.
 */
export function resolveRemoteFetch(
  env: NodeJS.ProcessEnv = process.env,
): ((url: string) => Promise<Buffer>) | undefined {
  if (!isEnabled(env)) return undefined;
  const allowHosts = parseAllowHosts(env.WALKIE_TALKIE_MCP_FETCH_ALLOW_HOSTS);
  if (allowHosts.size === 0) {
    console.warn(
      "[mcp] WALKIE_TALKIE_MCP_ALLOW_REMOTE_FETCH is set but WALKIE_TALKIE_MCP_FETCH_ALLOW_HOSTS is empty — remote fetch stays disabled.",
    );
    return undefined;
  }
  return (raw: string) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return Promise.reject(new Error("unparseable URL"));
    }
    return fetchOnce(url, allowHosts, 0);
  };
}
