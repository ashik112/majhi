import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../testing/fixtures.ts";
import { type Harness, harness } from "../testing/harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

describe("renaming personal to private", () => {
  const FIXTURE = [
    "workspaces: [~/Work]",
    "accounts:",
    "  claude-personal: { tool: claude, org: personal, auth: login }",
    "  claude-acme: { tool: claude, org: acme, auth: login }",
    "orgs:",
    "  acme: { name: Acme }",
    "projects:",
    "  notes: { org: personal, path: ~/Work/notes }",
    "",
  ].join("\n");
  const AGENT = [
    "---",
    "id: helper",
    "scope: acme",
    "role: Builder",
    "account: claude-personal",
    "where: [personal, acme]",
    "---",
    "Help.",
    "",
  ].join("\n");

  async function legacyHome() {
    h = await harness({ workspaces: false });
    const home = h.env.majhiHome;
    await mkdir(join(home, "agents"), { recursive: true });
    await writeFile(join(home, "majhi.yaml"), FIXTURE);
    await writeFile(join(home, "agents", "helper.md"), AGENT);
    return home;
  }

  it("rewrites accounts, projects and agents in one commit, and a second run does nothing", async () => {
    const home = await legacyHome();
    const service = h.majhi.services.config;
    await service.migrateLegacyOrg();
    expect(await service.migrateLegacyOrg()).toBe(false);
    const yaml = await readFile(join(home, "majhi.yaml"), "utf8");
    expect(yaml).not.toMatch(/org: personal/);
    expect(yaml).toContain("claude-personal: { tool: claude, org: private, auth: login }");
    expect(yaml).toContain("notes: { org: private, path: ~/Work/notes }");
    expect(yaml).toContain("claude-acme: { tool: claude, org: acme");
    const agent = await readFile(join(home, "agents", "helper.md"), "utf8");
    expect(agent).toContain("where: [ private, acme ]");
    expect(agent).toContain("account: claude-personal");
    expect(agent).toContain("scope: acme");
    expect(agent.endsWith("Help.\n")).toBe(true);

    const before = (await git(home, "rev-list", "--count", "HEAD")).trim();
    await service.migrateLegacyOrg();
    expect((await git(home, "rev-list", "--count", "HEAD")).trim()).toBe(before);
  });
});
