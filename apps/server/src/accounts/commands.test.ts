import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../testing/fixtures.ts";
import { type Harness, harness } from "../testing/harness.ts";

const KEY = "sk-test-fake-0000";
let h: Harness;
afterEach(() => h?.cleanup());

async function withOrg(options?: Parameters<typeof harness>[0]) {
  h = await harness(options);
  const org = await h.cmd("orgs.create", { id: "acme", name: "Acme" });
  expect(org.status).toBe(200);
}

describe("accounts.create", () => {
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
});
