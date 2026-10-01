import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../testing/fixtures.ts";
import { type Harness, harness } from "../testing/harness.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { orgKeys } from "./keys.ts";

let h: Harness;
let w: World;
afterEach(async () => {
  await h?.cleanup();
  await w?.cleanup();
});

const _yamlPath = () => join(h.env.majhiHome, "majhi.yaml");

describe("the built-in Private org", () => {
  it("gives its tasks PRV keys and reserves PRV against other orgs", async () => {
    w = await taskWorld();
    await w.addRepo("notes");
    expect(
      (await w.h.cmd("projects.register", { id: "notes", org: "private", path: "~/Work/notes" })).status,
    ).toBe(200);
    const task = await w.h.cmd("tasks.create", {
      text: "tidy notes",
      repos: [{ project: "notes" }],
      start: false,
    });
    expect(task.status).toBe(200);
    expect(task.body).toMatchObject({ id: "PRV-1", org: "private" });
    expect(orgKeys({ private: { name: "Private" }, prv: { name: "Prvco" } }).get("prv")).toBe("PRV2");
  });
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

  it("reads an old file as private before it is migrated", async () => {
    await legacyHome();
    const accounts = (await h.cmd("accounts.list")).body;
    expect(accounts.find((a: { id: string }) => a.id === "claude-personal").org).toBe("private");
    expect((await h.cmd("orgs.list")).body[0].accountCount).toBe(1);
    const agent = (await h.cmd("agents.list")).body.find(
      (e: { agent?: { frontmatter: { id: string } } }) => e.agent?.frontmatter.id === "helper",
    );
    expect(agent.agent.frontmatter.where).toEqual(["private", "acme"]);
  });

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

    const subjects = await git(home, "log", "--format=%s");
    expect(subjects.split("\n")[0]).toBe("config.migrate: Rename the Personal org to Private");
    const before = (await git(home, "rev-list", "--count", "HEAD")).trim();
    await service.migrateLegacyOrg();
    expect((await git(home, "rev-list", "--count", "HEAD")).trim()).toBe(before);
  });
});
