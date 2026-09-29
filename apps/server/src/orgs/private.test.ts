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

const yamlPath = () => join(h.env.majhiHome, "majhi.yaml");

describe("the built-in Private org", () => {
  it("is listed first with its defaults, even with no entry in majhi.yaml", async () => {
    h = await harness();
    const list = (await h.cmd("orgs.list")).body;
    expect(list[0]).toEqual({
      id: "private",
      name: "Private",
      color: "#8a8f98",
      key: "PRV",
      accountCount: 0,
      agentCount: 0,
    });
    expect(await readFile(yamlPath(), "utf8")).not.toContain("private");
  });

  it("stays first when other orgs exist, and counts its accounts", async () => {
    h = await harness();
    await h.cmd("orgs.create", { id: "acme", name: "Acme" });
    await h.cmd("accounts.create", { id: "claude-private", tool: "claude", org: "private", auth: "login" });
    const list = (await h.cmd("orgs.list")).body;
    expect(list.map((o: { id: string }) => o.id)).toEqual(["private", "acme"]);
    expect(list[0].accountCount).toBe(1);
  });

  it("writes an entry only when its settings change, and keeps the key default", async () => {
    h = await harness();
    const res = await h.cmd("orgs.update", { id: "private", name: "Mine", base: "develop" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "private", name: "Mine", base: "develop", key: "PRV" });
    expect(await readFile(yamlPath(), "utf8")).toContain("private:");
  });

  it("cannot be created again under either name", async () => {
    h = await harness();
    expect((await h.cmd("orgs.create", { id: "private", name: "X" })).status).toBe(400);
    expect((await h.cmd("orgs.create", { id: "personal", name: "X" })).status).toBe(400);
  });

  it("suggests <tool>-private account ids", async () => {
    h = await harness();
    expect((await h.cmd("accounts.suggestId", { tool: "claude", org: "private" })).body.id).toBe(
      "claude-private",
    );
  });

  it("gives its tasks PRV keys and reserves PRV against other orgs", async () => {
    w = await taskWorld();
    await w.addRepo("notes");
    expect(
      (await w.h.cmd("projects.register", { id: "notes", org: "private", path: "~/Work/notes" })).status,
    ).toBe(200);
    const task = await w.h.cmd("tasks.create", { text: "tidy notes", start: false });
    expect(task.status).toBe(200);
    expect(task.body).toMatchObject({ id: "PRV-1", org: "private" });
    expect(orgKeys({ private: { name: "Private" }, prv: { name: "Prvco" } }).get("prv")).toBe("PRV2");
  });

  it("lets an org agent use a private account", async () => {
    w = await taskWorld();
    await w.h.cmd("accounts.create", { id: "claude-private", tool: "claude", org: "private", auth: "login" });
    const res = await w.h.cmd("agents.create", {
      id: "acme-second",
      frontmatter: { scope: "acme", role: "Builder", account: "claude-private" },
      instructions: "",
    });
    expect(res.status).toBe(200);
    const listed = (await w.h.cmd("agents.list")).body.find(
      (e: { agent?: { frontmatter: { id: string } } }) => e.agent?.frontmatter.id === "acme-second",
    );
    expect(listed.warnings).toEqual([]);
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

  it("shows in History with Undo", async () => {
    await legacyHome();
    await h.majhi.services.config.migrateLegacyOrg();
    const [top] = (await h.cmd("history.list", { limit: 1 })).body;
    expect(top).toMatchObject({
      command: "config.migrate",
      actor: "majhi",
      summary: "Rename the Personal org to Private",
    });
    expect((await h.cmd("history.undo", { commit: top.commit })).status).toBe(200);
    expect(await readFile(yamlPath(), "utf8")).toContain("org: personal");
  });

  it("makes no commit when nothing refers to personal", async () => {
    h = await harness();
    const before = (await h.log()).length;
    expect(await h.majhi.services.config.migrateLegacyOrg()).toBe(false);
    expect((await h.log()).length).toBe(before);
  });
});
