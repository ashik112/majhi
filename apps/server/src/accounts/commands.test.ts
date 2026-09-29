import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { failedHealth, OK_HEALTH } from "../testing/fakeRuntime.ts";
import { git } from "../testing/fixtures.ts";
import { type Harness, harness } from "../testing/harness.ts";
import { AccountCache } from "./cache.ts";
import { AccountProbes, PROBE_REUSE_MS } from "./health.ts";
import { suggestAccountId } from "./service.ts";
import { statusFromHealth } from "./status.ts";

const KEY = "sk-test-fake-0000";
let h: Harness;
afterEach(() => h?.cleanup());

async function withOrg(options?: Parameters<typeof harness>[0]) {
  h = await harness(options);
  const org = await h.cmd("orgs.create", { id: "acme", name: "Acme" });
  expect(org.status).toBe(200);
}

describe("suggestAccountId", () => {
  it("returns the first free id", () => {
    expect(suggestAccountId("claude", "acme", new Set())).toBe("claude-acme");
    expect(suggestAccountId("claude", "acme", new Set(["claude-acme"]))).toBe("claude-acme-2");
    expect(
      suggestAccountId("claude", "acme", new Set(["claude-acme", "claude-acme-2", "claude-acme-4"])),
    ).toBe("claude-acme-3");
    expect(suggestAccountId("codex", "personal", new Set(["claude-personal"]))).toBe("codex-personal");
  });

  it("works through the command", async () => {
    await withOrg();
    await h.cmd("accounts.create", { id: "claude-acme", tool: "claude", org: "acme", auth: "login" });
    const res = await h.cmd("accounts.suggestId", { tool: "claude", org: "acme" });
    expect(res.body).toEqual({ id: "claude-acme-2" });
  });
});

describe("accounts.create", () => {
  it("adds a login account to majhi.yaml, prepares its home and commits", async () => {
    await withOrg();
    const res = await h.cmd(
      "accounts.create",
      { id: "claude-acme", tool: "claude", org: "acme", auth: "login" },
      { actor: { kind: "owner" }, reason: "first account" },
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "claude-acme",
      tool: "claude",
      org: "acme",
      auth: "login",
      home: join(h.env.majhiHome, "accounts/claude-acme"),
      agentCount: 0,
      status: "unknown",
    });
    expect(h.runtime.prepared.map((a) => a.home)).toEqual([join(h.env.majhiHome, "accounts/claude-acme")]);
    expect(await readFile(join(h.env.majhiHome, "majhi.yaml"), "utf8")).toContain("claude-acme:");
    expect((await h.log())[0]).toBe("accounts.create: first account");
    expect((await h.cmd("accounts.list")).body).toHaveLength(1);
  });

  it("fails clearly when the org does not exist, and allows personal", async () => {
    h = await harness();
    const missing = await h.cmd("accounts.create", {
      id: "claude-nope",
      tool: "claude",
      org: "nope",
      auth: "login",
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain('Org "nope" does not exist');

    const personal = await h.cmd("accounts.create", {
      id: "claude-personal",
      tool: "claude",
      org: "personal",
      auth: "login",
    });
    expect(personal.status).toBe(200);
  });

  it("refuses a taken id and suggests a free one", async () => {
    await withOrg();
    const body = { id: "claude-acme", tool: "claude", org: "acme", auth: "login" };
    await h.cmd("accounts.create", body);
    const again = await h.cmd("accounts.create", body);
    expect(again.status).toBe(409);
    expect(again.body.error).toContain('"claude-acme-2"');
  });

  it("needs a first run before any account", async () => {
    h = await harness({ workspaces: false });
    const res = await h.cmd("orgs.create", { id: "acme", name: "Acme" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("workspace roots");
  });

  it("stores an API key encrypted, and it never reaches majhi.yaml, git, output or the cache", async () => {
    await withOrg();
    const created = await h.cmd("accounts.create", {
      id: "claude-api",
      tool: "claude",
      org: "acme",
      auth: "api-key",
      apiKey: KEY,
    });
    expect(created.status).toBe(200);
    await h.cmd("accounts.health", { id: "claude-api" });

    const yaml = await readFile(join(h.env.majhiHome, "majhi.yaml"), "utf8");
    expect(yaml).toContain("key: secret:claude-api");
    expect(yaml).not.toContain(KEY);

    const outputs = JSON.stringify([
      created.body,
      (await h.cmd("accounts.list")).body,
      (await h.cmd("config.get")).body,
      (await h.cmd("accounts.models", { id: "claude-api" })).body,
    ]);
    expect(outputs).not.toContain(KEY);

    const history = await git(h.env.majhiHome, "log", "-p", "--all", "--format=%B");
    expect(history).not.toContain(KEY);
    expect(await git(h.env.majhiHome, "ls-files")).not.toContain("secrets.age");
    expect(existsSync(join(h.env.majhiHome, "secrets.age"))).toBe(true);
    const cache = await readFile(join(h.env.majhiHome, "cache/accounts/claude-api.json"), "utf8");
    expect(cache).not.toContain(KEY);
  });

  it("hands the decrypted key to the probe and nothing else from the server", async () => {
    await withOrg();
    await h.cmd("accounts.create", {
      id: "claude-api",
      tool: "claude",
      org: "acme",
      auth: "api-key",
      apiKey: KEY,
    });
    await h.cmd("accounts.health", { id: "claude-api" });

    expect(h.runtime.probes).toHaveLength(1);
    expect(h.runtime.probes[0]?.account).toEqual({
      tool: "claude",
      home: join(h.env.majhiHome, "accounts/claude-api"),
      apiKey: KEY,
    });
    expect(h.runtime.probes[0]?.options.base).toEqual(h.env.runtime.base);
  });

  it("needs the secrets key for API keys, but not for logins", async () => {
    await withOrg({ key: false });
    const api = await h.cmd("accounts.create", {
      id: "claude-api",
      tool: "claude",
      org: "acme",
      auth: "api-key",
      apiKey: KEY,
    });
    expect(api.status).toBe(409);
    expect(api.body.error).toBe("Secrets are not set up: run make up");
    expect((await h.cmd("accounts.list")).body).toEqual([]);

    const login = await h.cmd("accounts.create", {
      id: "claude-acme",
      tool: "claude",
      org: "acme",
      auth: "login",
    });
    expect(login.status).toBe(200);
  });

  it("rejects an API key on a login account and none on an API-key account", async () => {
    await withOrg();
    const a = await h.cmd("accounts.create", {
      id: "x-1",
      tool: "claude",
      org: "acme",
      auth: "login",
      apiKey: KEY,
    });
    const b = await h.cmd("accounts.create", { id: "x-2", tool: "claude", org: "acme", auth: "api-key" });
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
  });
});

describe("accounts.remove", () => {
  it("refuses while agent files use the account and lists them", async () => {
    await withOrg();
    await h.cmd("accounts.create", { id: "claude-acme", tool: "claude", org: "acme", auth: "login" });
    await h.cmd("agents.create", {
      id: "builder",
      frontmatter: { scope: "acme", role: "Builder", account: "claude-acme" },
      instructions: "Build.",
    });

    const res = await h.cmd("accounts.remove", { id: "claude-acme" });
    expect(res.status).toBe(409);
    expect(res.body.details).toEqual(["builder"]);
    expect((await h.cmd("accounts.list")).body[0].agentCount).toBe(1);
  });

  it("removes the entry, the home, the secret and the cache", async () => {
    await withOrg();
    await h.cmd("accounts.create", {
      id: "claude-api",
      tool: "claude",
      org: "acme",
      auth: "api-key",
      apiKey: KEY,
    });
    await h.cmd("accounts.health", { id: "claude-api" });
    const home = join(h.env.majhiHome, "accounts/claude-api");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, ".credentials.json"), "{}");

    const res = await h.cmd("accounts.remove", { id: "claude-api" });
    expect(res.body).toEqual({ removed: "claude-api" });

    expect((await h.cmd("accounts.list")).body).toEqual([]);
    expect(existsSync(home)).toBe(false);
    expect(existsSync(join(h.env.majhiHome, "cache/accounts/claude-api.json"))).toBe(false);
    expect(await h.majhi.services.secrets.get("claude-api")).toBeUndefined();
    expect(await readFile(join(h.env.majhiHome, "majhi.yaml"), "utf8")).not.toContain("claude-api");
    expect((await h.log())[0]).toBe("accounts.remove: removed account claude-api");
  });

  it("answers 404 for an unknown account", async () => {
    await withOrg();
    expect((await h.cmd("accounts.remove", { id: "nope" })).status).toBe(404);
  });
});

describe("health", () => {
  it("maps probe results to a status", () => {
    expect(statusFromHealth(undefined)).toBe("unknown");
    expect(statusFromHealth(OK_HEALTH)).toBe("healthy");
    expect(statusFromHealth(failedHealth("auth"))).toBe("needs-login");
    expect(statusFromHealth(failedHealth("cli"))).toBe("unreachable");
    expect(statusFromHealth(failedHealth("acp"))).toBe("unreachable");
  });

  it("shows unknown, then the status of the last check, and survives a restart", async () => {
    await withOrg();
    await h.cmd("accounts.create", { id: "claude-acme", tool: "claude", org: "acme", auth: "login" });
    expect((await h.cmd("accounts.list")).body[0].status).toBe("unknown");

    h.runtime.probe = { health: failedHealth("auth") };
    const res = await h.cmd("accounts.health", { id: "claude-acme" });
    expect(res.body.health.ok).toBe(false);
    expect(res.body.account.status).toBe("needs-login");

    const restarted = h.restart();
    expect((await restarted.cmd("accounts.list")).body[0].status).toBe("needs-login");
  });

  it("reports the signed-in email and reuses a fresh probe", async () => {
    await withOrg();
    await h.cmd("accounts.create", { id: "claude-acme", tool: "claude", org: "acme", auth: "login" });
    h.runtime.probe = { ...h.runtime.probe, health: { ...OK_HEALTH, checkedAt: new Date().toISOString() } };

    const first = await h.cmd("accounts.health", { id: "claude-acme" });
    const second = await h.cmd("accounts.health", { id: "claude-acme" });
    expect(first.body.account).toMatchObject({ status: "healthy", signedInAs: "owner@example.com" });
    expect(second.body.health).toEqual(first.body.health);
    expect(h.runtime.probes).toHaveLength(1);
  });

  it("probes again once the last result is older than 30 seconds", async () => {
    await withOrg();
    await h.cmd("accounts.create", { id: "claude-acme", tool: "claude", org: "acme", auth: "login" });
    let now = Date.parse("2026-01-01T00:00:00Z");
    const probes = new AccountProbes({
      majhiHome: h.env.majhiHome,
      runtime: h.runtime,
      options: h.env.runtime,
      secrets: h.majhi.services.secrets,
      cache: new AccountCache(join(h.dir, "other-cache")),
      now: () => now,
    });
    const config = { tool: "claude", org: "acme", auth: "login" } as const;

    await probes.check("claude-acme", config);
    now += PROBE_REUSE_MS - 1;
    await probes.check("claude-acme", config);
    expect(h.runtime.probes).toHaveLength(1);
    now += 2;
    await probes.check("claude-acme", config);
    expect(h.runtime.probes).toHaveLength(2);
  });

  it("turns a crashing probe into an unreachable account", async () => {
    await withOrg();
    await h.cmd("accounts.create", { id: "claude-acme", tool: "claude", org: "acme", auth: "login" });
    h.runtime.probeAccount = async () => {
      throw new Error("spawn claude-agent-acp ENOENT");
    };
    const res = await h.cmd("accounts.health", { id: "claude-acme" });
    expect(res.body.account.status).toBe("unreachable");
    expect(res.body.health.steps[0]).toEqual({
      name: "cli",
      ok: false,
      detail: "spawn claude-agent-acp ENOENT",
    });
  });
});

describe("accounts.models", () => {
  it("probes once, then answers from the cache until refresh", async () => {
    await withOrg();
    await h.cmd("accounts.create", { id: "claude-acme", tool: "claude", org: "acme", auth: "login" });

    const first = await h.cmd("accounts.models", { id: "claude-acme" });
    expect(first.body.account).toBe("claude-acme");
    expect(first.body.models.map((m: { id: string }) => m.id)).toEqual(["opus", "sonnet"]);
    await h.cmd("accounts.models", { id: "claude-acme" });
    expect(h.runtime.probes).toHaveLength(1);

    await h.cmd("accounts.models", { id: "claude-acme", refresh: true });
    expect(h.runtime.probes).toHaveLength(2);
  });

  it("explains why there are no models", async () => {
    await withOrg();
    await h.cmd("accounts.create", { id: "claude-acme", tool: "claude", org: "acme", auth: "login" });
    h.runtime.probe = { health: failedHealth("auth") };
    const res = await h.cmd("accounts.models", { id: "claude-acme" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Cannot read the models of claude-acme: auth: auth failed");
  });
});

describe("tools and orgs", () => {
  it("lists tools", async () => {
    h = await harness();
    const res = await h.cmd("tools.list");
    expect(res.body.map((t: { id: string }) => t.id)).toEqual(["claude", "codex"]);
  });

  it("creates an org, counts accounts, and reserves ids", async () => {
    await withOrg();
    await h.cmd("accounts.create", { id: "claude-acme", tool: "claude", org: "acme", auth: "login" });
    expect((await h.cmd("orgs.list")).body).toEqual([
      { id: "acme", name: "Acme", key: "ACM", accountCount: 1, agentCount: 0 },
    ]);
    expect((await h.cmd("orgs.create", { id: "acme", name: "Again" })).status).toBe(409);
    expect((await h.cmd("orgs.create", { id: "personal", name: "Me" })).status).toBe(400);
  });
});
