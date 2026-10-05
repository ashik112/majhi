import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStore } from "../agents/store.ts";
import { migrateAgentSkills } from "./migrate.ts";
import { SkillStore } from "./store.ts";

const agentFile = (id: string, skills: string) =>
  `---\nid: ${id}\nscope: acme\nrole: Builder\naccount: claude-acme\nwhere: [anywhere]\n${skills}---\n\nBuild.\n`;

describe("migrateAgentSkills", () => {
  let home: string;
  let agents: AgentStore;
  let skills: SkillStore;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "majhi-skill-migrate-"));
    await mkdir(join(home, "agents"));
    agents = new AgentStore(home);
    skills = new SkillStore(home);
    for (const name of ["lint", "deploy"]) {
      const folder = join(home, "src", name);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: Does ${name}\n---\n`);
      await skills.put(name, folder, { source: folder, sourceType: "local" });
      await skills.changeMany([name], (entry) => ({ ...entry, defaultOn: false }));
    }
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  const fake = {
    legacySkills: async () =>
      (await agents.list()).flatMap((e) =>
        e.ok && e.legacySkills.length > 0 ? [{ id: e.id, skills: e.legacySkills }] : [],
      ),
    dropLegacySkills: async (ids: string[]) => {
      for (const id of ids) {
        const found = await agents.get(id);
        if (found?.ok) await agents.write(found.agent);
      }
    },
  };
  const meta = { actor: { kind: "owner" as const } };

  it("turns listed skills into opt-ins, drops the list from the file, and does nothing the second time", async () => {
    await writeFile(agents.path("builder"), agentFile("builder", "skills: [lint, gone]\n"));
    await writeFile(agents.path("tester"), agentFile("tester", "skills: [lint, deploy]\n"));
    await writeFile(agents.path("plain"), agentFile("plain", ""));
    // An opt-out always won over a listing, so it still does.
    await skills.setOptOut("deploy", "tester", true);

    expect(await migrateAgentSkills({ agents: fake, store: skills }, meta)).toBe(2);

    expect(await skills.effectiveFor({ id: "builder", scope: "acme" })).toEqual(["lint"]);
    expect(await skills.effectiveFor({ id: "tester", scope: "acme" })).toEqual(["lint"]);
    expect(await skills.effectiveFor({ id: "plain", scope: "acme" })).toEqual([]);
    expect(await readFile(agents.path("builder"), "utf8")).not.toContain("skills");

    const lock = await readFile(join(home, "skills", "skills-lock.json"), "utf8");
    expect(await migrateAgentSkills({ agents: fake, store: skills }, meta)).toBe(0);
    expect(await readFile(join(home, "skills", "skills-lock.json"), "utf8")).toBe(lock);
  });

  it("applies the agent's own choice before the workspace and all-agents rules", async () => {
    await skills.changeMany(["lint"], (entry) => ({
      ...entry,
      defaultOn: true,
      orgs: { acme: "off" },
      optIn: ["builder"],
      optOut: ["tester"],
    }));
    expect(await skills.effectiveFor({ id: "builder", scope: "acme" })).toContain("lint");
    expect(await skills.effectiveFor({ id: "tester", scope: "acme" })).not.toContain("lint");
    expect(await skills.effectiveFor({ id: "other", scope: "acme" })).not.toContain("lint");
    expect(await skills.effectiveFor({ id: "other", scope: "globex" })).toContain("lint");
  });
});
