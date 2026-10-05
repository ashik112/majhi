import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandMeta } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { git, tempDir } from "../testing/fixtures.ts";
import { ConfigService } from "./service.ts";
import { ConfigConflictError } from "./write.ts";

const OWNER: CommandMeta = { actor: { kind: "owner" } };

function change(meta: CommandMeta = OWNER, summary = "set workspaces") {
  return { command: "workspaces.set", meta, summary };
}

describe("ConfigService.setWorkspaces", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let majhiHome: string;
  let service: ConfigService;
  const log = (format: string) => git(majhiHome, "log", `--format=${format}`);

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    majhiHome = join(dir, ".majhi");
    service = new ConfigService({ majhiHome, hostHome: dir });
  });
  afterEach(() => cleanup());

  it("keeps keys and comments it does not own", async () => {
    await mkdir(majhiHome);
    await writeFile(
      service.file,
      [
        "# majhi config, edited by hand",
        "workspaces: [~/Old] # my roots",
        "tasks_dir: ~/tasks",
        "limits: { agents_max: 6 } # keep me",
        "orgs:",
        "  acme:",
        "    name: ACME # the company",
        "",
      ].join("\n"),
    );

    const loaded = await service.setWorkspaces({ workspaces: ["~/Work", "~/personal"] }, change());

    const text = await readFile(service.file, "utf8");
    expect(text).toContain("# majhi config, edited by hand");
    expect(text).toContain("# my roots");
    expect(text).toContain("# keep me");
    expect(text).toContain("# the company");
    expect(parse(text)).toEqual({
      workspaces: ["~/Work", "~/personal"],
      limits: { agents_max: 6 },
      orgs: { acme: { name: "ACME" } },
    });
    expect(loaded.state).toMatchObject({
      status: "loaded",
      config: { workspaces: [join(dir, "Work"), join(dir, "personal")], tasksDir: join(dir, "Work/.majhi") },
    });
  });

  it("commits hand edits on their own, so undoing a command keeps them", async () => {
    await service.setWorkspaces({ workspaces: ["~/Work"] }, change());
    await writeFile(service.file, "# hand edit\nworkspaces: [~/Work]\nlimits: { agents_max: 2 }\n");

    await service.setWorkspaces({ workspaces: ["~/Work", "~/personal"] }, change());

    expect((await log("%s")).split("\n").slice(0, 2)).toEqual([
      "workspaces.set: set workspaces",
      "manual: changes made outside majhi",
    ]);
    const changed = (await git(majhiHome, "show", "--format=", "HEAD"))
      .split("\n")
      .filter((line) => /^[+-](?![+-])/.test(line));
    expect(changed).toEqual(["-workspaces: [~/Work]", "+workspaces: [ ~/Work, ~/personal ]"]);
  });

  it("refuses to rewrite a file with YAML errors", async () => {
    await mkdir(majhiHome);
    const broken = "workspaces: [~/Work\n";
    await writeFile(service.file, broken);
    await expect(service.setWorkspaces({ workspaces: ["~/x"] }, change())).rejects.toBeInstanceOf(
      ConfigConflictError,
    );
    expect(await readFile(service.file, "utf8")).toBe(broken);
  });
});
