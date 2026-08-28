import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearStoredToken, readStoredToken, tokenKey, writeStoredToken } from "../token-store.js";

const dirs: string[] = [];
function tmpEnv(): NodeJS.ProcessEnv {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wt-tok-"));
  dirs.push(d);
  return { WALKIE_TALKIE_STATE_DIR: d } as NodeJS.ProcessEnv;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("token store", () => {
  it("round-trips a token so a new process can reclaim", () => {
    const env = tmpEnv();
    expect(readStoredToken("http://h:9559", "alice", env)).toBeNull();
    writeStoredToken("http://h:9559", "alice", "tok-123", env);
    expect(readStoredToken("http://h:9559", "alice", env)).toBe("tok-123");
  });

  it("keys separately per hub and per callsign", () => {
    const env = tmpEnv();
    writeStoredToken("http://a:9559", "alice", "A", env);
    writeStoredToken("http://b:9559", "alice", "B", env);
    writeStoredToken("http://a:9559", "bob", "C", env);
    expect(readStoredToken("http://a:9559", "alice", env)).toBe("A");
    expect(readStoredToken("http://b:9559", "alice", env)).toBe("B");
    expect(readStoredToken("http://a:9559", "bob", env)).toBe("C");
  });

  it("clears on sign-off", () => {
    const env = tmpEnv();
    writeStoredToken("http://h:9559", "alice", "tok", env);
    clearStoredToken("http://h:9559", "alice", env);
    expect(readStoredToken("http://h:9559", "alice", env)).toBeNull();
  });

  it("writes 0600 — the token grants the callsign", () => {
    const env = tmpEnv();
    writeStoredToken("http://h:9559", "alice", "tok", env);
    const f = path.join(env.WALKIE_TALKIE_STATE_DIR as string, tokenKey("http://h:9559", "alice"));
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it("never lets a name escape into a path", () => {
    expect(tokenKey("http://h:9559", "../../etc/passwd")).not.toContain("/");
    expect(tokenKey("http://h:9559", "../../etc/passwd")).not.toContain("..");
  });

  it("survives an unusable state dir without throwing", () => {
    // Use a regular file as the parent so mkdir fails with ENOTDIR immediately. (A path under
    // /proc would look like a natural choice but mkdirSync BLOCKS there rather than erroring.)
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wt-tok-"));
    dirs.push(d);
    const asFile = path.join(d, "not-a-dir");
    fs.writeFileSync(asFile, "x");
    const env = { WALKIE_TALKIE_STATE_DIR: path.join(asFile, "sub") } as NodeJS.ProcessEnv;
    expect(() => writeStoredToken("http://h:9559", "a", "t", env)).not.toThrow();
    expect(readStoredToken("http://h:9559", "a", env)).toBeNull();
  });
});
