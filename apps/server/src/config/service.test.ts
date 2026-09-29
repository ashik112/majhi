import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandMeta } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { git, tempDir } from "../testing/fixtures.ts";
import { GITIGNORE } from "./history.ts";
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

  it("starts the history on first write, with a .gitignore for secrets and databases", async () => {
    await service.setWorkspaces({ workspaces: ["~/Work"], tasks_dir: "~/tasks" }, change());

    expect(await readFile(join(majhiHome, ".gitignore"), "utf8")).toBe(`${GITIGNORE.join("\n")}\n`);
    expect((await log("%s")).split("\n")).toEqual([
      "workspaces.set: set workspaces",
      "init: start config history",
    ]);
    expect(parse(await readFile(service.file, "utf8"))).toEqual({
      workspaces: ["~/Work"],
      tasks_dir: "~/tasks",
    });

    await mkdir(join(majhiHome, "accounts", "claude-acme"), { recursive: true });
    await writeFile(join(majhiHome, "accounts", "claude-acme", "credentials.json"), "{}");
    await writeFile(join(majhiHome, "majhi.db"), "");
    await writeFile(join(majhiHome, "majhi.db-wal"), "");
    expect(await git(majhiHome, "status", "--porcelain")).toBe("");
  });

  it("adds the lines an older .gitignore lacks, in their own commit, keeping the owner's lines", async () => {
    await service.setWorkspaces({ workspaces: ["~/Work"] }, change());
    const old = "accounts/\nagent-homes/\n# mine\nnotes/";
    await writeFile(join(majhiHome, ".gitignore"), old);
    await git(majhiHome, "add", ".gitignore");
    await git(majhiHome, "commit", "--quiet", "-m", "old gitignore");

    await service.setWorkspaces({ workspaces: ["~/Work", "~/personal"] }, change());

    const lines = (await readFile(join(majhiHome, ".gitignore"), "utf8")).split("\n");
    expect(lines.slice(0, 4)).toEqual(["accounts/", "agent-homes/", "# mine", "notes/"]);
    expect(lines.filter((l) => l === "accounts/")).toHaveLength(1);
    expect(new Set(lines)).toEqual(new Set([...GITIGNORE, "# mine", "notes/", ""]));
    expect((await log("%s")).split("\n").slice(0, 2)).toEqual([
      "workspaces.set: set workspaces",
      "gitignore: keep new private files out of the history",
    ]);

    await mkdir(join(majhiHome, "logs"));
    await writeFile(join(majhiHome, "logs", "host.log"), "x");
    await writeFile(join(majhiHome, "host.token"), "secret");
    expect(await git(majhiHome, "status", "--porcelain")).toBe("");
  });

  it("makes no commit when the content does not change", async () => {
    await service.setWorkspaces({ workspaces: ["~/Work"] }, change());
    const before = await log("%H");
    await service.setWorkspaces({ workspaces: ["~/Work"] }, change());
    expect(await log("%H")).toBe(before);
  });

  it("records the actor as author, majhi as committer, and the reason in the message", async () => {
    await service.setWorkspaces(
      { workspaces: ["~/Work"] },
      change({ actor: { kind: "agent", id: "majhi-boss" }, reason: "owner asked for ~/Work" }),
    );
    expect(await log("%an <%ae>|%cn <%ce>|%s")).toMatch(
      /^majhi-boss <majhi-boss@majhi\.local>\|majhi <majhi@majhi\.local>\|workspaces\.set: owner asked for ~\/Work\n/,
    );

    await service.setWorkspaces({ workspaces: ["~/personal"] }, change());
    expect((await log("%an <%ae>|%s")).split("\n")[0]).toBe(
      "Owner <owner@majhi.local>|workspaces.set: set workspaces",
    );
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
