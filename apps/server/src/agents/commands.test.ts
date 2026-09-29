import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { failedHealth } from "../testing/fakeRuntime.ts";
import { git } from "../testing/fixtures.ts";
import { type Harness, harness } from "../testing/harness.ts";

let h: Harness;
afterEach(() => h?.cleanup());

const draft = (over: Record<string, unknown> = {}) => ({
  frontmatter: { scope: "acme", role: "Builder", account: "claude-acme", ...over },
  instructions: "Build things.\n",
});

async function setup() {
  h = await harness();
  await h.cmd("orgs.create", { id: "acme", name: "Acme" });
  await h.cmd("accounts.create", { id: "claude-acme", tool: "claude", org: "acme", auth: "login" });
  await h.cmd("accounts.models", { id: "claude-acme" });
}

const agentsDir = () => join(h.env.majhiHome, "agents");

describe("agent commands", () => {
  it("creates, updates, duplicates and removes agent files, one commit each", async () => {
    await setup();
    const created = await h.cmd(
      "agents.create",
      { id: "builder", ...draft({ model: "sonnet" }) },
      { reason: "new builder" },
    );
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      status: "ok",
      file: "builder.md",
      warnings: [],
      isBoss: false,
      agent: { frontmatter: { id: "builder", model: "sonnet" }, instructions: "Build things.\n" },
    });
    expect(await readFile(join(agentsDir(), "builder.md"), "utf8")).toContain("id: builder\nscope: acme");
    expect((await h.log())[0]).toBe("agents.create: new builder");

    const updated = await h.cmd("agents.update", {
      id: "builder",
      ...draft({ model: "opus", effort: "high" }),
    });
    expect(updated.body.agent.frontmatter).toMatchObject({ model: "opus", effort: "high" });
    expect((await h.log())[0]).toBe("agents.update: updated agent builder");

    const copy = await h.cmd("agents.duplicate", { id: "builder", newId: "builder-2" });
    expect(copy.body.agent.frontmatter.id).toBe("builder-2");
    expect(copy.body.agent.instructions).toBe("Build things.\n");
    expect((await h.cmd("agents.list")).body.map((e: { file: string }) => e.file)).toEqual([
      "builder-2.md",
      "builder.md",
    ]);

    const removed = await h.cmd("agents.remove", { id: "builder-2" });
    expect(removed.body).toEqual({ removed: "builder-2" });
    expect((await h.cmd("agents.list")).body).toHaveLength(1);
    expect((await h.log())[0]).toBe("agents.remove: removed agent builder-2");
  });

  it("refuses duplicates of ids, and updates or removals of unknown agents", async () => {
    await setup();
    await h.cmd("agents.create", { id: "builder", ...draft() });
    expect((await h.cmd("agents.create", { id: "builder", ...draft() })).status).toBe(409);
    expect((await h.cmd("agents.duplicate", { id: "builder", newId: "builder" })).status).toBe(409);
    expect((await h.cmd("agents.update", { id: "nope", ...draft() })).status).toBe(404);
    expect((await h.cmd("agents.remove", { id: "nope" })).status).toBe(404);
  });

  it("lists invalid files with their errors instead of dropping them", async () => {
    await setup();
    await mkdir(agentsDir(), { recursive: true });
    await writeFile(join(agentsDir(), "broken.md"), "---\nid: broken\nscope: acme\n---\nx");
    await writeFile(join(agentsDir(), "notes.txt"), "ignored");

    const list = (await h.cmd("agents.list")).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "invalid", id: "broken", file: "broken.md" });
    expect(list[0].errors.join("\n")).toContain("role");
  });

  it("warns about accounts, orgs, models and fallbacks without refusing the file", async () => {
    await setup();
    await h.cmd("orgs.create", { id: "globex", name: "Globex" });
    await h.cmd("agents.create", {
      id: "wanderer",
      ...draft({ scope: "globex", model: "gpt-9", effort: "extreme", fallback: "ghost" }),
    });
    await h.cmd("agents.create", { id: "orphan", ...draft({ account: "claude-gone" }) });
    await h.cmd("agents.create", { id: "auto-one", ...draft({ model: "auto", effort: "auto" }) });
    await h.cmd("accounts.create", { id: "claude-personal", tool: "claude", org: "private", auth: "login" });
    await h.cmd("agents.create", { id: "shared", ...draft({ scope: "globex", account: "claude-personal" }) });
    await h.cmd("agents.create", { id: "rooter", ...draft({ scope: "root", role: "Root" }) });

    const by = Object.fromEntries(
      (await h.cmd("agents.list")).body.map(
        (e: { agent: { frontmatter: { id: string } }; warnings: string[] }) => [
          e.agent.frontmatter.id,
          e.warnings,
        ],
      ),
    );
    expect(by.wanderer).toEqual([
      'Account "claude-acme" belongs to org "acme", but this agent works in "globex"',
      'Model "gpt-9" is not offered by claude-acme',
      'Effort "extreme" is not offered by claude-acme',
      'Fallback agent "ghost" does not exist',
    ]);
    expect(by.orphan).toEqual(['Account "claude-gone" is not in majhi.yaml']);
    expect(by["auto-one"]).toEqual([]);
    expect(by.shared).toEqual([]);
    expect(by.rooter).toEqual([]);
  });

  it("commits hand edits in agents/ as manual before the next change", async () => {
    await setup();
    await h.cmd("agents.create", { id: "builder", ...draft() });
    const file = join(agentsDir(), "builder.md");
    await writeFile(file, `${await readFile(file, "utf8")}\nMy own note.\n`);

    await h.cmd("agents.create", { id: "second", ...draft() });

    const log = await h.log("%s|%an");
    expect(log[0]).toBe("agents.create: created agent second|Owner");
    expect(log[1]).toBe("manual: changes made outside majhi|Owner");
    expect(await git(h.env.majhiHome, "show", "--stat", "--format=", "HEAD~1")).toContain(
      "agents/builder.md",
    );
  });

  it("records the acting agent and reason", async () => {
    await setup();
    await h.cmd(
      "agents.create",
      { id: "builder", ...draft() },
      { actor: { kind: "agent", id: "boss" }, reason: "needed one" },
    );
    expect((await h.log("%s|%an"))[0]).toBe("agents.create: needed one|boss");
  });
});

describe("boss", () => {
  it("only a valid root agent can be boss, and the boss cannot be removed", async () => {
    await setup();
    await h.cmd("agents.create", { id: "builder", ...draft() });
    await h.cmd("agents.create", { id: "chief", ...draft({ scope: "root", role: "Root" }) });
    await mkdir(agentsDir(), { recursive: true });
    await writeFile(join(agentsDir(), "broken.md"), "---\nid: broken\n---\n");

    expect((await h.cmd("boss.set", { id: "nope" })).status).toBe(404);
    expect((await h.cmd("boss.set", { id: "builder" })).status).toBe(409);
    expect((await h.cmd("boss.set", { id: "broken" })).status).toBe(409);

    expect((await h.cmd("boss.set", { id: "chief" })).body).toEqual({ boss: "chief" });
    expect(await readFile(join(h.env.majhiHome, "majhi.yaml"), "utf8")).toContain("boss: chief");
    expect((await h.log())[0]).toBe("boss.set: made chief the boss");
    const chief = (await h.cmd("agents.list")).body.find((e: { file: string }) => e.file === "chief.md");
    expect(chief.isBoss).toBe(true);

    const removal = await h.cmd("agents.remove", { id: "chief" });
    expect(removal.status).toBe(409);
    expect(removal.body.error).toContain("is the boss");
    await rm(join(agentsDir(), "broken.md"));
  });
});

describe("agents.health", () => {
  it("adds a model step to the account checks", async () => {
    await setup();
    await h.cmd("agents.create", { id: "good", ...draft({ model: "opus", effort: "high" }) });
    await h.cmd("agents.create", { id: "auto", ...draft({ model: "auto" }) });
    await h.cmd("agents.create", { id: "stale", ...draft({ model: "opus-3", effort: "max" }) });

    const good = (await h.cmd("agents.health", { id: "good" })).body;
    expect(good.ok).toBe(true);
    expect(good.steps.map((s: { name: string }) => s.name)).toEqual(["cli", "auth", "acp", "model"]);
    expect((await h.cmd("agents.health", { id: "auto" })).body.ok).toBe(true);

    const stale = (await h.cmd("agents.health", { id: "stale" })).body;
    expect(stale.ok).toBe(false);
    expect(stale.steps.at(-1)).toEqual({
      name: "model",
      ok: false,
      detail:
        'Model "opus-3" is not offered. Offered: opus, sonnet. Effort "max" is not offered. Offered: low, high',
    });
  });

  it("returns the account's failure when the account is unhealthy or missing", async () => {
    await setup();
    await h.cmd("agents.create", { id: "builder", ...draft() });
    await h.cmd("agents.create", { id: "orphan", ...draft({ account: "claude-gone" }) });
    h.runtime.probe = { health: failedHealth("auth") };
    const sick = (await h.cmd("accounts.health", { id: "claude-acme" })).body;
    expect(sick.health.ok).toBe(false);

    const res = (await h.cmd("agents.health", { id: "builder" })).body;
    expect(res.ok).toBe(false);
    expect(res.steps).toEqual([{ name: "auth", ok: false, detail: "auth failed" }]);

    const orphan = (await h.cmd("agents.health", { id: "orphan" })).body;
    expect(orphan.steps[0].detail).toBe('Account "claude-gone" is not in majhi.yaml');
  });
  it("edits only the named fields, can clear optional ones, and refuses an invalid result", async () => {
    await setup();
    await h.cmd("agents.create", {
      id: "builder",
      ...draft({ perms: ["edit", "shell"], model: "sonnet", fallback: "builder" }),
    });
    const edited = await h.cmd("agents.edit", {
      id: "builder",
      set: { model: null, role: "Lead" },
      instructions: "Lead the work.\n",
    });
    expect(edited.status).toBe(200);
    const fm = edited.body.agent.frontmatter;
    expect(fm).toMatchObject({
      role: "Lead",
      perms: ["edit", "shell"],
      fallback: "builder",
      account: "claude-acme",
    });
    expect(fm.model).toBeUndefined();
    expect(edited.body.agent.instructions).toBe("Lead the work.\n");

    const before = await readFile(join(agentsDir(), "builder.md"), "utf8");
    const bad = await h.cmd("agents.edit", { id: "builder", set: { perms: ["fly"] } });
    expect(bad.status).toBe(400);
    expect(await readFile(join(agentsDir(), "builder.md"), "utf8")).toBe(before);
  });
});
