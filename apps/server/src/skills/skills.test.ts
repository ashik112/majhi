import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Skill, SkillPreview } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";
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

  it("installs only after a confirmed second call, and never enables on its own", async () => {
    const preview = (await must("skills.install", { source: "acme/agent-skills" })) as SkillPreview;
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

    it("refuses a symlink that points out of the folder, and a folder outside the workspace", async () => {
      await write(folder("linked"), "linked", "Has a link");
      await writeFile(join(w.h.dir, "secret.txt"), "top secret");
      await symlink(join(w.h.dir, "secret.txt"), join(folder("linked"), "notes.md"));
      const res = await run("skills.install", { source: folder("linked") });
      expect(res.status).toBe(400);

      await write(join(w.h.dir, "elsewhere", "far"), "far", "Out of bounds");
      const far = await run("skills.install", { source: join(w.h.dir, "elsewhere", "far") });
      expect(far.status).toBe(400);
      // Never majhi's own home.
      const home = await run("skills.install", { source: join(w.h.env.majhiHome, "agents") });
      expect(home.status).toBe(400);
    });
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
