import { describe, expect, it } from "vitest";
import { isBlockedAddress, parseAllowHosts, resolveRemoteFetch } from "../fetch-guard.js";

/**
 * The hub-side fetcher is the difference between "radio_send_image reads a URL" and "any holder
 * of the shared join token has a request forger inside the HIPAA boundary". These assertions are
 * the boundary of that difference.
 */

describe("isBlockedAddress", () => {
  it("blocks the cloud metadata server", () => {
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
  });

  it("blocks loopback, RFC1918 and CGNAT — where every internal service on this host lives", () => {
    for (const a of ["127.0.0.1", "10.0.3.7", "172.17.0.2", "192.168.1.10", "100.100.5.5", "0.0.0.0"]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
  });

  it("blocks the IPv6 equivalents, including v4-mapped forms", () => {
    for (const a of ["::1", "::", "fe80::1", "fd00::1", "ff02::1", "::ffff:169.254.169.254", "::ffff:10.1.2.3"]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const a of ["93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946"]) {
      expect(isBlockedAddress(a), a).toBe(false);
    }
  });

  it("refuses anything that is not an IP rather than guessing", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("parseAllowHosts", () => {
  it("splits, trims and lowercases; ignores empties", () => {
    expect([...parseAllowHosts(" CDN.Example.com , images.example.org ,, ")]).toEqual([
      "cdn.example.com",
      "images.example.org",
    ]);
    expect(parseAllowHosts(undefined).size).toBe(0);
  });
});

describe("resolveRemoteFetch", () => {
  it("is off by default", () => {
    expect(resolveRemoteFetch({})).toBeUndefined();
  });

  it("stays off when opted in with no allowlist", () => {
    // "allow fetching, from anywhere" is the configuration nobody means to write, and it is
    // precisely the one that hands over the metadata server.
    expect(resolveRemoteFetch({ WALKIE_TALKIE_MCP_ALLOW_REMOTE_FETCH: "1" })).toBeUndefined();
    expect(
      resolveRemoteFetch({ WALKIE_TALKIE_MCP_ALLOW_REMOTE_FETCH: "1", WALKIE_TALKIE_MCP_FETCH_ALLOW_HOSTS: " , " }),
    ).toBeUndefined();
  });

  it("turns on only with both an opt-in and an allowlist", () => {
    const fetcher = resolveRemoteFetch({
      WALKIE_TALKIE_MCP_ALLOW_REMOTE_FETCH: "1",
      WALKIE_TALKIE_MCP_FETCH_ALLOW_HOSTS: "cdn.example.com",
    });
    expect(typeof fetcher).toBe("function");
  });

  it("refuses a host outside the allowlist without opening a connection", async () => {
    const fetcher = resolveRemoteFetch({
      WALKIE_TALKIE_MCP_ALLOW_REMOTE_FETCH: "1",
      WALKIE_TALKIE_MCP_FETCH_ALLOW_HOSTS: "cdn.example.com",
    });
    await expect(fetcher!("http://169.254.169.254/computeMetadata/v1/")).rejects.toThrow(/not in this hub/);
    await expect(fetcher!("http://cloudsql-proxy:5432/")).rejects.toThrow(/not in this hub/);
  });

  it("refuses a non-http protocol and an unparseable URL", async () => {
    const fetcher = resolveRemoteFetch({
      WALKIE_TALKIE_MCP_ALLOW_REMOTE_FETCH: "1",
      WALKIE_TALKIE_MCP_FETCH_ALLOW_HOSTS: "cdn.example.com",
    });
    await expect(fetcher!("file:///secrets/config.json")).rejects.toThrow(/unsupported protocol/);
    await expect(fetcher!("not a url")).rejects.toThrow(/unparseable/);
  });

  it("refuses an allowlisted host that resolves to a private address", async () => {
    // localhost is in the allowlist and resolves to 127.0.0.1: the second gate is what stops
    // a public hostname whose A record points inside.
    const fetcher = resolveRemoteFetch({
      WALKIE_TALKIE_MCP_ALLOW_REMOTE_FETCH: "1",
      WALKIE_TALKIE_MCP_FETCH_ALLOW_HOSTS: "localhost",
    });
    await expect(fetcher!("http://localhost:9/")).rejects.toThrow(/private or link-local/);
  });
});
