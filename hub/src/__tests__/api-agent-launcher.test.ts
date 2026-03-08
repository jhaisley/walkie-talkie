import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

vi.mock("../launcher.js", () => ({
  launchAgent: vi.fn(),
  autoLaunchAgents: vi.fn(),
}));

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

function adminHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ctx.adminToken}`,
  };
}

describe("Agent config CRUD API", () => {
  let configId: string;

  it("should create an agent config", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-agent-config-create`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "test-agent", workDir: "/tmp" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBeDefined();
    configId = body.id;
  });

  it("should list agent configs", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-agent-configs`, {
      headers: { Authorization: `Bearer ${ctx.adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configs: { id: string; name: string; workDir: string; command: string; autoStart: boolean; online: boolean }[];
    };
    expect(body.configs.length).toBeGreaterThanOrEqual(1);
    const config = body.configs.find((c) => c.id === configId);
    expect(config).toBeDefined();
    expect(config!.name).toBe("test-agent");
    expect(config!.workDir).toBe("/tmp");
    expect(config!.autoStart).toBe(false);
    expect(config!.online).toBe(false);
  });

  it("should reject creating a config with missing fields", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-agent-config-create`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "bad" }),
    });
    expect(res.status).toBe(400);
  });

  it("should reject invalid agent name", async () => {
    for (const badName of ["has space", "has;semi", 'has"quote', "has$dollar"]) {
      const res = await fetch(`${ctx.baseUrl}/admin-agent-config-create`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ name: badName, workDir: "/tmp" }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("should reject duplicate agent name", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-agent-config-create`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "test-agent", workDir: "/tmp" }),
    });
    expect(res.status).toBe(409);
  });

  it("should update an agent config", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-agent-config-update`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ id: configId, name: "test-agent-updated", autoStart: true }),
    });
    expect(res.status).toBe(200);

    // Verify the update
    const listRes = await fetch(`${ctx.baseUrl}/admin-agent-configs`, {
      headers: { Authorization: `Bearer ${ctx.adminToken}` },
    });
    const body = (await listRes.json()) as {
      configs: { id: string; name: string; autoStart: boolean }[];
    };
    const config = body.configs.find((c) => c.id === configId);
    expect(config!.name).toBe("test-agent-updated");
    expect(config!.autoStart).toBe(true);
  });

  it("should return 404 when updating non-existent config", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-agent-config-update`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ id: "non-existent-id", name: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("should delete an agent config", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-agent-config-delete`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ id: configId }),
    });
    expect(res.status).toBe(200);

    // Verify deletion
    const listRes = await fetch(`${ctx.baseUrl}/admin-agent-configs`, {
      headers: { Authorization: `Bearer ${ctx.adminToken}` },
    });
    const body = (await listRes.json()) as { configs: { id: string }[] };
    expect(body.configs.find((c) => c.id === configId)).toBeUndefined();
  });

  it("should return 404 when deleting non-existent config", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-agent-config-delete`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ id: "non-existent-id" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("Agent launch API", () => {
  it("should return 404 when launching non-existent config", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-agent-start`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ id: "non-existent" }),
    });
    expect(res.status).toBe(404);
  });

  it("should return 200 when launching a valid config", async () => {
    // Create a config
    const createRes = await fetch(`${ctx.baseUrl}/admin-agent-config-create`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "launch-test", workDir: "/tmp" }),
    });
    const createBody = (await createRes.json()) as { id: string };

    // Launch (will fail to open iTerm2 in test, but API returns 200)
    const res = await fetch(`${ctx.baseUrl}/admin-agent-start`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ id: createBody.id }),
    });
    expect(res.status).toBe(200);

    // Clean up
    await fetch(`${ctx.baseUrl}/admin-agent-config-delete`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ id: createBody.id }),
    });
  });

  it("should require admin auth for all agent endpoints", async () => {
    const endpoints = [
      { method: "GET", path: "/admin-agent-configs" },
      { method: "POST", path: "/admin-agent-config-create" },
      { method: "POST", path: "/admin-agent-config-update" },
      { method: "POST", path: "/admin-agent-config-delete" },
      { method: "POST", path: "/admin-agent-start" },
    ];
    for (const ep of endpoints) {
      const res = await fetch(`${ctx.baseUrl}${ep.path}`, {
        method: ep.method,
        headers: { "Content-Type": "application/json" },
        body: ep.method === "POST" ? JSON.stringify({}) : undefined,
      });
      expect(res.status).toBe(401);
    }
  });
});
