import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Skill, SkillInstallResult, SkillPreview } from "@majhi/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFilesRoot } from "../connections/run-files.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { makeZip } from "../testing/zip.ts";
import { skillsServer } from "./mcp.ts";
import { cleanSource } from "./service.ts";

const FAKE_CLI = {
  command: process.execPath,
  args: [fileURLToPath(new URL("../testing/fake-skills.mjs", import.meta.url))],
};
const SEARCH = {
  skills: [
    {
      id: "acme/agent-skills/lint-fixes",
      source: "acme/agent-skills",
      skillId: "lint-fixes",
      name: "lint-fixes",
      installs: 42,
    },
    { id: "globex/tools/deploy", source: "globex/tools", skillId: "deploy", name: "deploy", installs: 7 },
  ],
};

describe("skills", () => {
  let w: World;
  const run = async (name: string, body: unknown, meta?: unknown) => w.h.cmd(name, body, meta);
  const must = async (name: string, body: unknown, meta?: unknown) => {
    const res = await run(name, body, meta);
    if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const installAll = async (body: Record<string, unknown>) => {
    const preview = (await must("skills.install", body)) as SkillPreview;
    expect(preview.status).toBe("preview");
    const done = (await must("skills.install", { confirm: preview.previewId })) as SkillInstallResult;
    if (done.status !== "installed") throw new Error("not installed");
    return { preview, skills: done.skills };
  };
  /** Installs, then puts the skill in the state skills had before the all-agents rule: on for no agent. */
  const install = async (body: Record<string, unknown>) => {
    const out = await installAll(body);
    const file = join(store(), "skills-lock.json");
    const lock = JSON.parse(await readFile(file, "utf8"));
    for (const skill of out.skills) lock.skills[skill.name].defaultOn = false;
    await writeFile(file, JSON.stringify(lock));
    return { preview: out.preview, skills: out.skills.map((s) => ({ ...s, defaultOn: false, agents: [] })) };
  };
  const store = () => join(w.h.env.majhiHome, "skills");
  const exists = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    );
  const auditKinds = () =>
    w.h.majhi.services.store.permissions
      .audit("")
      .map((r) => r.kind)
      .filter((k) => k.startsWith("skill-"));

  beforeEach(async () => {
    w = await taskWorld({
      skillsCommand: FAKE_CLI,
      skillsFetch: async () => ({ ok: true, status: 200, json: async () => SEARCH }),
    });
  });
  afterEach(() => w.cleanup());

  it("searches the directory and shows the source repo", async () => {
    const found = (await must("skills.search", { query: "lint" })) as {
      source: string;
      install: unknown;
      installed: boolean;
    }[];
    expect(found[0]).toMatchObject({
      source: "acme/agent-skills",
      install: { source: "acme/agent-skills", skill: "lint-fixes" },
      installed: false,
    });
  });

  it("installs only after a confirmed second call, and never enables on its own", async () => {
    const preview = (await must("skills.install", { source: "acme/agent-skills" })) as SkillPreview;
    expect(preview.skills.map((s) => s.name)).toEqual(["lint-fixes", "release-notes"]);
    expect(preview.skills[0]).toMatchObject({ description: "Fix lint errors the Acme way" });
    expect(preview.skills[0]?.files).toEqual([{ path: "SKILL.md", size: expect.any(Number) }]);
    expect(preview.source).toMatchObject({
      source: "acme/agent-skills",
      sourceType: "github",
      commit: expect.any(String),
    });
    // Nothing is in the store yet.
    expect(await must("skills.list", {})).toEqual([]);
    expect(await exists(join(store(), "lint-fixes"))).toBe(false);

    const done = (await must("skills.install", { confirm: preview.previewId })) as {
      status: string;
      skills: Skill[];
    };
    expect(done.status).toBe("installed");
    expect(done.skills.map((s) => s.name)).toEqual(["lint-fixes", "release-notes"]);
    expect(done.skills.every((s) => s.defaultOn)).toBe(true);
    expect(await readFile(join(store(), "lint-fixes", "SKILL.md"), "utf8")).toContain("Fix lint errors");
    const lock = JSON.parse(await readFile(join(store(), "skills-lock.json"), "utf8"));
    expect(lock.skills["lint-fixes"]).toMatchObject({
      source: "acme/agent-skills",
      sourceType: "github",
      commit: "0123456789abcdef0123456789abcdef01234567",
      computedHash: preview.skills[0]?.hash,
    });
    expect(auditKinds()).toEqual(["skill-install", "skill-install"]);

    // A preview is used once, and an unknown one is refused.
    expect((await run("skills.install", { confirm: preview.previewId })).status).toBe(404);
    expect((await run("skills.install", { confirm: "nope" })).status).toBe(404);
    // The throwaway stage is gone.
    const stages = await readdir(join(w.h.dir, "Work", ".majhi", ".skills")).catch(() => []);
    expect(stages).toEqual([]);
  });

  it("a new skill is on for every agent, agents made later get it, and an opt-out sticks", async () => {
    await installAll({ source: "acme/agent-skills", skill: "lint-fixes" });
    const has = async (agent: string) =>
      ((await must("skills.list", { agent })) as Skill[]).map((s) => s.name);
    expect(await has("acme-builder")).toEqual(["lint-fixes"]);

    await must("agents.create", {
      id: "acme-late",
      frontmatter: { scope: "acme", role: "Reviewer", account: "claude-acme" },
      instructions: "Help.",
    });
    expect(await has("acme-late")).toEqual(["lint-fixes"]);
    expect(await w.h.majhi.services.skillStore.effectiveFor("acme-late", [])).toEqual(["lint-fixes"]);

    await must("skills.disable", { name: "lint-fixes", agent: "acme-builder" });
    expect(await has("acme-builder")).toEqual([]);
    expect(await has("acme-late")).toEqual(["lint-fixes"]);
    // Updating the skill keeps the opt-out.
    const lock = () => readFile(join(store(), "skills-lock.json"), "utf8");
    expect(JSON.parse(await lock()).skills["lint-fixes"]).toMatchObject({
      defaultOn: true,
      optOut: ["acme-builder"],
    });
    expect(await w.h.majhi.services.skillStore.effectiveFor("acme-builder", [])).toEqual([]);

    // Turning it back on for that agent, and "enable for all" clears every opt-out.
    await must("skills.disable", { name: "lint-fixes", agent: "acme-late" });
    await must("skills.enableAll", { name: "lint-fixes" });
    expect(await has("acme-builder")).toEqual(["lint-fixes"]);
    expect(await has("acme-late")).toEqual(["lint-fixes"]);
  });

  it("installs one skill of a source when asked", async () => {
    const { skills } = await install({ source: "acme/agent-skills", skill: "release-notes" });
    expect(skills.map((s) => s.name)).toEqual(["release-notes"]);
    expect(await exists(join(store(), "lint-fixes"))).toBe(false);
    expect((await run("skills.install", { source: "acme/agent-skills", skill: "nope" })).status).toBe(400);
  });

  it("enables per agent through the agent file, and a run gets only that agent's skills", async () => {
    await install({ source: "acme/agent-skills" });
    await must("skills.enable", { name: "lint-fixes", agent: "acme-builder" });
    expect(((await must("skills.list", { agent: "acme-builder" })) as Skill[]).map((s) => s.name)).toEqual([
      "lint-fixes",
    ]);
    expect(await readFile(join(w.h.env.majhiHome, "agents", "acme-builder.md"), "utf8")).toContain(
      "lint-fixes",
    );
    // Enabling twice changes nothing.
    await must("skills.enable", { name: "lint-fixes", agent: "acme-builder" });
    expect(auditKinds().filter((k) => k === "skill-enable")).toHaveLength(1);

    const task = (await must("tasks.create", {
      text: "tidy the api, repo api",
      repos: [{ project: "acme-api" }],
      start: true,
    })) as { id: string };
    await w.h.majhi.services.runs.idle(task.id);
    const start = w.h.runtime.starts.at(-1);
    const mount = start?.mounts?.find((m) => m.path.includes(`${join("run", "connections")}/skills-`));
    expect(mount?.readOnly).toBe(true);
    const dir = mount?.path ?? "";
    expect(join(dir, "..")).toBe(runFilesRoot(w.h.env.majhiHome));
    expect(await readdir(dir)).toEqual(["lint-fixes"]);
    expect(await readFile(join(dir, "lint-fixes", "SKILL.md"), "utf8")).toContain("Fix lint errors");
    // The prompt holds one short line, no list and no skill text. The agent looks a skill up with majhi-skills.
    const prompt = JSON.stringify(w.h.runtime.sessions[0]?.prompts[0]);
    expect(prompt).toContain("The owner turned on 1 skill for you");
    expect(prompt).not.toContain("lint-fixes");
    expect(prompt).not.toContain("Fix lint errors");
    expect(start?.mcpServers?.map((m) => m.name)).toContain("majhi-skills");

    // The copy goes with the session.
    await must("tasks.stop", { id: task.id });
    for (let i = 0; i < 50 && (await exists(dir)); i++) await new Promise((r) => setTimeout(r, 20));
    expect(await exists(dir)).toBe(false);
  });

  it("a started run gets default-on skills (mount and note), a resumed run too, an opted-out skill not", async () => {
    await installAll({ source: "acme/agent-skills" });
    const task = (await must("tasks.create", {
      text: "tidy the api, repo api",
      repos: [{ project: "acme-api" }],
      start: true,
    })) as { id: string };
    await w.h.majhi.services.runs.idle(task.id);
    const mountOf = () => w.h.runtime.starts.at(-1)?.mounts?.find((m) => m.path.includes("/skills-"));
    const first = mountOf();
    expect(first?.readOnly).toBe(true);
    expect((await readdir(first?.path ?? "")).sort()).toEqual(["lint-fixes", "release-notes"]);
    const prompt = JSON.stringify(w.h.runtime.sessions.at(-1)?.prompts[0]);
    expect(prompt).toContain("The owner turned on 2 skills for you");
    // No list and no skill text in the prompt.
    expect(prompt).not.toContain("lint-fixes");
    expect(prompt).not.toContain('SKILL.md"');
    expect(prompt.length).toBeLessThan(900);

    // majhi-skills finds what is on and nothing else.
    const find = async (query: string) => {
      const mine = w.h.majhi.services.runs.skillsOf(task.id, "acme-builder");
      const [near, far] = InMemoryTransport.createLinkedPair();
      const server = skillsServer(
        { task: task.id, agent: "acme-builder" },
        { forRun: async () => (mine === undefined ? undefined : { dir: mine.dir, skills: mine.items }) },
      );
      await server.connect(far);
      const client = new Client({ name: "test", version: "1" });
      await client.connect(near);
      const res = (await client.callTool({ name: "find", arguments: { query } })) as {
        content: { text: string }[];
      };
      await client.close();
      return res.content[0]?.text ?? "";
    };
    expect(await find("fix lint errors")).toContain(join(first?.path ?? "", "lint-fixes", "SKILL.md"));
    expect(await find("release notes")).toContain("release-notes");

    // Opt one out, then send another message: the restarted (resumed) session has only the other.
    await must("skills.disable", { name: "release-notes", agent: "acme-builder" });
    await must("room.send", { task: task.id, text: "next step please" });
    await w.h.majhi.services.runs.idle(task.id);
    const second = mountOf();
    expect(second?.path).not.toBe(first?.path);
    expect(await readdir(second?.path ?? "")).toEqual(["lint-fixes"]);
    expect(JSON.stringify(w.h.runtime.sessions.at(-1)?.prompts)).toContain(
      "The owner turned on 1 skill for you",
    );
    expect(await find("release notes")).toBe("No skill matches. Try other words, or go on without one.");
    expect(await find("lint")).toContain("lint-fixes");
  });

  it("a workspace switch opts out exactly that workspace's agents, covers later agents, and one change writes once", async () => {
    await installAll({ source: "acme/agent-skills" });
    for (const [id, scope] of [
      ["globex-dev", "root"],
      ["acme-late", "acme"],
    ] as const) {
      await must("agents.create", {
        id,
        frontmatter: { scope, role: "Reviewer", account: "claude-acme" },
        instructions: "Help.",
      });
    }
    const on = async (name: string) =>
      ((await must("skills.list", {})) as Skill[]).find((s) => s.name === name)?.agents.sort() ?? [];
    const everyone = ["acme-builder", "acme-late", "globex-dev"];
    expect(await on("lint-fixes")).toEqual(everyone);

    const file = join(store(), "skills-lock.json");
    const writes = async () => (await readFile(file, "utf8")).length;
    void writes;
    const before = await stat(file);
    await must("skills.setMany", {
      skills: ["lint-fixes", "release-notes"],
      target: { kind: "workspace", org: "acme" },
      on: false,
    });
    const after = await stat(file);
    expect(after.mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs);
    // Exactly the acme agents lost both skills; the other workspace kept them.
    expect(await on("lint-fixes")).toEqual(["globex-dev"]);
    expect(await on("release-notes")).toEqual(["globex-dev"]);
    // An agent made later in that workspace follows the workspace rule.
    await must("agents.create", {
      id: "acme-newest",
      frontmatter: { scope: "acme", role: "Reviewer", account: "claude-acme" },
      instructions: "Help.",
    });
    expect(await on("lint-fixes")).toEqual(["globex-dev"]);
    const { skillStore } = w.h.majhi.services;
    expect(await skillStore.effectiveFor("acme-newest", [], "acme")).toEqual([]);
    expect(await skillStore.effectiveFor("globex-dev", [], "root")).toEqual(["lint-fixes", "release-notes"]);

    // On again clears those opt-outs and the rule.
    await must("skills.setMany", {
      skills: ["lint-fixes", "release-notes"],
      target: { kind: "workspace", org: "acme" },
      on: true,
    });
    expect(await on("lint-fixes")).toEqual([...everyone, "acme-newest"].sort());
    const lock = JSON.parse(await readFile(file, "utf8")).skills["lint-fixes"];
    expect(lock.optOut).toEqual([]);

    // Agents target: only those agents; the lock holds the choice, not the agent files.
    await must("skills.setMany", {
      skills: ["lint-fixes"],
      target: { kind: "agents", agents: ["acme-late", "globex-dev"] },
      on: false,
    });
    expect(await on("lint-fixes")).toEqual(["acme-builder", "acme-newest"]);
    // All agents off covers an agent whose file lists the skill, then on restores everyone.
    await must("skills.enable", { name: "lint-fixes", agent: "acme-late" });
    await must("skills.setMany", { skills: ["lint-fixes"], target: { kind: "all" }, on: false });
    expect(await on("lint-fixes")).toEqual([]);
    await must("skills.setMany", { skills: ["lint-fixes"], target: { kind: "all" }, on: true });
    expect(await on("lint-fixes")).toEqual([...everyone, "acme-newest"].sort());
    // An unknown skill changes nothing.
    expect(
      (await run("skills.setMany", { skills: ["nope", "lint-fixes"], target: { kind: "all" }, on: false }))
        .status,
    ).toBe(404);
    expect(await on("lint-fixes")).toEqual([...everyone, "acme-newest"].sort());
  });

  it("restarts the agent's open session when a skill is turned on, so the next turn has it", async () => {
    await install({ source: "acme/agent-skills" });
    const task = (await must("tasks.create", {
      text: "tidy the api, repo api",
      repos: [{ project: "acme-api" }],
      start: true,
    })) as { id: string };
    await w.h.majhi.services.runs.idle(task.id);
    const before = w.h.runtime.starts.length;
    expect(w.h.runtime.starts.at(-1)?.mounts?.some((m) => m.path.includes("/skills-"))).toBe(false);

    await must("skills.enable", { name: "lint-fixes", agent: "acme-builder" });
    await must("room.send", { task: task.id, text: "now fix the lint errors" });
    await w.h.majhi.services.runs.idle(task.id);

    expect(w.h.runtime.starts.length).toBeGreaterThan(before);
    const start = w.h.runtime.starts.at(-1);
    const mount = start?.mounts?.find((m) => m.path.includes("/skills-"));
    expect(mount?.readOnly).toBe(true);
    const prompts = w.h.runtime.sessions.at(-1)?.prompts ?? [];
    expect(JSON.stringify(prompts)).toContain("The owner turned on 1 skill for you");
  });

  it("gives a run with no skills no folder and no note", async () => {
    await install({ source: "acme/agent-skills" });
    const task = (await must("tasks.create", {
      text: "tidy the api, repo api",
      repos: [{ project: "acme-api" }],
      start: true,
    })) as { id: string };
    await w.h.majhi.services.runs.idle(task.id);
    expect(w.h.runtime.starts.at(-1)?.mounts?.some((m) => m.path.includes("/skills-"))).toBe(false);
    expect(JSON.stringify(w.h.runtime.sessions[0]?.prompts[0])).not.toContain("Skills the owner turned on");
  });

  it("disables, and removing takes the skill off every agent that lists it", async () => {
    await install({ source: "acme/agent-skills" });
    await must("skills.enable", { name: "lint-fixes", agent: "acme-builder" });
    await must("skills.enable", { name: "release-notes", agent: "acme-builder" });
    await must("skills.disable", { name: "release-notes", agent: "acme-builder" });
    expect(((await must("skills.list", { agent: "acme-builder" })) as Skill[]).map((s) => s.name)).toEqual([
      "lint-fixes",
    ]);

    expect(await must("skills.remove", { name: "lint-fixes" })).toEqual({
      removed: "lint-fixes",
      agents: ["acme-builder"],
    });
    expect(await readFile(join(w.h.env.majhiHome, "agents", "acme-builder.md"), "utf8")).not.toContain(
      "lint-fixes",
    );
    expect(await exists(join(store(), "lint-fixes"))).toBe(false);
    expect((await run("skills.enable", { name: "lint-fixes", agent: "acme-builder" })).status).toBe(404);
    expect((await run("skills.remove", { name: "lint-fixes" })).status).toBe(404);
    expect(auditKinds()).toEqual([
      "skill-install",
      "skill-install",
      "skill-enable",
      "skill-enable",
      "skill-disable",
      "skill-remove",
    ]);
  });

  describe("from a folder", () => {
    const folder = (name: string) => join(w.h.dir, "Work", name);
    const write = async (
      dir: string,
      name: string,
      description: string,
      extra: Record<string, string> = {},
    ) => {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
      );
      for (const [file, text] of Object.entries(extra)) {
        await mkdir(join(dir, file, ".."), { recursive: true });
        await writeFile(join(dir, file), text);
      }
    };

    it("installs it, and an update previews the change before it lands", async () => {
      await write(folder("my-skill"), "my-skill", "Does the thing", { "ref/a.md": "one" });
      const { skills } = await install({ source: folder("my-skill") });
      expect(skills[0]).toMatchObject({ name: "my-skill", sourceType: "local", source: folder("my-skill") });
      expect(skills[0]?.files.map((f) => f.path)).toEqual(["SKILL.md", "ref/a.md"]);

      // Nothing changed: unchanged, and no preview is left.
      expect(await must("skills.update", { name: "my-skill" })).toMatchObject({ status: "unchanged" });

      await write(folder("my-skill"), "my-skill", "Does the thing better", { "ref/a.md": "two" });
      const preview = (await must("skills.update", { name: "my-skill" })) as SkillPreview;
      expect(preview.status).toBe("preview");
      expect(preview.skills[0]?.replaces?.hash).toBe(skills[0]?.hash);
      expect(((await must("skills.list", {})) as Skill[])[0]?.description).toBe("Does the thing");
      await must("skills.update", { name: "my-skill", confirm: preview.previewId });
      expect(((await must("skills.list", {})) as Skill[])[0]?.description).toBe("Does the thing better");
      expect(auditKinds()).toEqual(["skill-install", "skill-update"]);
    });

    it("refuses a SKILL.md without a valid name and description", async () => {
      await mkdir(folder("bad"), { recursive: true });
      await writeFile(join(folder("bad"), "SKILL.md"), "---\nname: Bad Name\ndescription: x\n---\n");
      expect(
        ((await run("skills.install", { source: folder("bad") })).body as { error: string }).error,
      ).toMatch(/name of lowercase/);
      await writeFile(join(folder("bad"), "SKILL.md"), "no frontmatter\n");
      expect(
        ((await run("skills.install", { source: folder("bad") })).body as { error: string }).error,
      ).toMatch(/frontmatter/);
      await writeFile(join(folder("bad"), "SKILL.md"), "---\nname: ok\n---\n");
      expect(
        ((await run("skills.install", { source: folder("bad") })).body as { error: string }).error,
      ).toMatch(/description/);
      expect(await must("skills.list", {})).toEqual([]);
    });

    it("refuses a symlink that points out of the folder, and a folder outside the workspace", async () => {
      await write(folder("linked"), "linked", "Has a link");
      await writeFile(join(w.h.dir, "secret.txt"), "top secret");
      await symlink(join(w.h.dir, "secret.txt"), join(folder("linked"), "notes.md"));
      const res = await run("skills.install", { source: folder("linked") });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/points outside/);

      await write(join(w.h.dir, "elsewhere", "far"), "far", "Out of bounds");
      const far = await run("skills.install", { source: join(w.h.dir, "elsewhere", "far") });
      expect(far.body.error).toMatch(/inside a workspace root/);
      // Never majhi's own home.
      const home = await run("skills.install", { source: join(w.h.env.majhiHome, "agents") });
      expect(home.status).toBe(400);
    });
  });

  it("installs from an uploaded zip, and refuses a zip that tries to leave its folder", async () => {
    const upload = async (data: Buffer, name = "skill.zip") => {
      const form = new FormData();
      form.append("file", new File([new Uint8Array(data)], name, { type: "application/zip" }));
      const res = await w.h.majhi.app.request("/api/uploads", { method: "POST", body: form });
      return ((await res.json()) as { id: string }).id;
    };
    const good = makeZip([
      { name: "zipped/SKILL.md", data: "---\nname: zipped\ndescription: From a zip\n---\n" },
      { name: "zipped/ref/a.md", data: "hi" },
    ]);
    const { skills } = await install({ upload: await upload(good) });
    expect(skills[0]).toMatchObject({ name: "zipped", sourceType: "upload", source: "upload:skill.zip" });
    expect(await exists(join(store(), "zipped", "ref", "a.md"))).toBe(true);

    const evil = makeZip([
      { name: "zipped/SKILL.md", data: "---\nname: zipped\ndescription: x\n---\n" },
      { name: "../../../escaped.txt", data: "owned" },
    ]);
    const res = await run("skills.install", { upload: await upload(evil, "evil.zip") });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/leaves its folder/);
    expect(await exists(join(w.h.dir, "escaped.txt"))).toBe(false);
    expect(await exists(join(w.h.dir, "Work", "escaped.txt"))).toBe(false);
  });

  it("an agent can confirm only a preview it made itself", async () => {
    const owner = (await must("skills.install", { source: "acme/agent-skills" })) as SkillPreview;
    const agent = { actor: { kind: "agent", id: "acme-builder" } };
    const res = await run("skills.install", { confirm: owner.previewId }, agent);
    expect(res.status).toBe(409);
    // The owner can still confirm it.
    expect(((await must("skills.install", { confirm: owner.previewId })) as { status: string }).status).toBe(
      "installed",
    );
  });

  it("records no credential: a source's user name, password and query are dropped", () => {
    expect(cleanSource("https://user:tok3n@github.com/acme/skills?token=abc#x")).toBe(
      "https://github.com/acme/skills#x",
    );
    expect(cleanSource("acme/skills")).toBe("acme/skills");
    expect(cleanSource("git@github.com:acme/skills.git")).toBe("git@github.com:acme/skills.git");
  });
});
