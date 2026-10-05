import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rankSkills } from "../skills/find.ts";
import { prepareRunSkills } from "./skills.ts";

describe("prepareRunSkills", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "majhi-runskills-"));
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  const store = (names: string[]) => ({
    get: async (name: string) =>
      names.includes(name)
        ? {
            name,
            description: `Does ${name} well. ${"Long description. ".repeat(40)}`,
          }
        : undefined,
    pathOf: (name: string) => join(home, "store", name),
  });
  const install = async (names: string[]) => {
    for (const n of names) {
      await mkdir(join(home, "store", n), { recursive: true });
      await writeFile(join(home, "store", n, "SKILL.md"), `# ${n}\n`);
    }
  };

  // biome-ignore lint/suspicious/noExplicitAny: the store's other methods are not used here
  const deps = (names: string[]) => ({ store: store(names) as any, majhiHome: home });

  it("overlays the copies where Claude Code looks, with no prompt text, however many skills", async () => {
    const names = Array.from({ length: 60 }, (_, i) => `skill-${i}`);
    await install(names);
    const target = "/Users/owner/Work/.majhi/ACM-1/.claude/skills";
    const got = await prepareRunSkills(deps(names), names, { overlayTarget: target });
    expect(got?.note).toBe("");
    expect(got?.mounts).toEqual([{ path: got?.dir, readOnly: true, target }]);
    expect((await readdir(got?.dir ?? "")).length).toBe(60);
  });

  it("without the overlay the prompt carries one short line, the same for 3 or 60 skills", async () => {
    const names = Array.from({ length: 60 }, (_, i) => `skill-${i}`);
    await install(names);
    const sixty = await prepareRunSkills(deps(names), names);
    const three = await prepareRunSkills(deps(names), names.slice(0, 3));
    expect(sixty?.mounts).toEqual([{ path: sixty?.dir, readOnly: true }]);
    expect(sixty?.note.length).toBeLessThan(400);
    expect(sixty?.note).not.toContain("skill-1");
    expect(three?.note.length).toBeLessThan(400);
  });

  it("finds by words in the name or the description, and nothing for unrelated words", () => {
    const skills = [
      { name: "review-merge-request", description: "Review a GitLab merge request for bugs" },
      { name: "release-notes", description: "Write release notes from commits" },
      { name: "prisma-client-api", description: "Use the Prisma client" },
    ];
    expect(rankSkills(skills, "review a merge request")[0]?.name).toBe("review-merge-request");
    expect(rankSkills(skills, "notes for the release").map((s) => s.name)).toEqual(["release-notes"]);
    expect(rankSkills(skills, "kubernetes")).toEqual([]);
  });
});
