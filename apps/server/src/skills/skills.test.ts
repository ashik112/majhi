import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Skill, SkillInstallResult, SkillPreview } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";
import { makeZip } from "../testing/zip.ts";
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
