import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../testing/fixtures.ts";
import { ConfigService } from "./service.ts";

let cleanup: () => Promise<void>;
let service: ConfigService;
beforeEach(async () => {
  const made = await tempDir();
  cleanup = made.cleanup;
  const majhiHome = join(made.dir, ".majhi");
  await mkdir(majhiHome);
  service = new ConfigService({ majhiHome, hostHome: made.dir });
});
afterEach(() => cleanup());

/** A majhi.yaml as it grows over months: the old table, ship rules, flags, full access and 33 saved rules. */
const rows =
  "{ start: decide, questions: decide, approvals: decide, upkeep: decide, merge: decide, push: decide, deployStaging: ask, deployProduction: decide, tell: ask, own: decide }";
const rule = (command: string, where: string) => `    - { agent: acme-lead, command: ${command}, ${where} }`;
const TASKS: Record<string, string> = {
  "ACM-1": "acme",
  "ACM-2": "acme",
  "GLX-3": "globex",
  "NW-4": "northwind",
  "INI-5": "initech",
};
const FILE = [
  "workspaces: [~/Work]",
  "orgs:",
  "  acme: { name: Acme }",
  "  globex: { name: Globex }",
  "  northwind: { name: Northwind }",
  "  initech: { name: Initech }",
  "autonomy:",
  "  pick: { size: any, orgs: [initech] }",
  "  orgs:",
  "    private: { level: tidy }",
  `    acme: { authority: ${rows}, cap: { cost: 5 }, ships: [{ id: abcd1234, when: { types: [bug] }, merge: decide, deployStaging: ask, deployProduction: ask, tell: ask }] }`,
  "    globex: { fullAccess: true }",
  "    initech: { push: true }",
  "policy:",
  "  rules:",
  // Ten identical per-task rules for something inside the task.
  ...Array.from({ length: 10 }, (_, i) => rule("tasks.create", `task: ACM-${i + 10}`)),
  rule("tasks.create", "org: acme"),
  rule('"shell:cd api && pnpm test"', "org: acme"),
  rule('"tool:acme-deploy.release"', "org: acme"),
  rule('"connection:gh-acme:gh run rerun 12"', "org: acme"),
  rule("containers.preview.build", "task: ACM-1"),
  // Merge and push: kept only where the new level does not already allow them, once per workspace and kind.
  rule("tasks.merge", "task: ACM-1"),
  rule("tasks.merge", "task: ACM-2"),
  rule("tasks.merge", "task: GLX-3"),
  rule("tasks.merge", "org: globex"),
  rule("tasks.openMrs", "task: NW-4"),
  rule("tasks.push", "task: NW-4"),
  rule("tasks.push", "task: INI-5"),
  // Never kept: a task that is gone, a delete, a production deploy.
  rule("tasks.merge", "task: GONE-9"),
  rule("tasks.remove", "org: acme"),
  rule("projects.deploy", "org: acme"),
  "",
].join("\n");

describe("the move to authority levels", () => {
  it("gives each workspace its nearest level, keeps one rule per workspace and kind, drops what the levels allow, and runs once", async () => {
    await writeFile(service.file, FILE);
    expect(await service.migrateLevels({ orgOfTask: (task) => TASKS[task] })).toBe(true);

    const { autonomy, policy } = await service.settings();
    expect(autonomy.orgs).toEqual({
      // Tidy in the owner's own space: it worked there, so Routine.
      private: { level: "routine" },
      // The captain merged here, and Deploy production was its own: Full, with Captain ships for the fix.
      acme: { level: "full", cap: { cost: 5 }, incident: { fix: "ships" } },
      // Full access, but Merge and Push were the owner's: nothing outward was given, so Ask me.
      globex: { level: "ask" },
      // Never configured: what it effectively was.
      northwind: { level: "ask" },
      // Listed in the old pick rule with a push flag: it worked and pushed.
      initech: { level: "routine" },
    });
    expect(autonomy.pick.orgs).toBeUndefined();
    // Acme is Full and Initech Routine, so their merge and push rules are covered; the rest is one rule each.
    expect(policy.rules).toEqual([
      { org: "globex", kind: "merge-main" },
      { org: "northwind", kind: "push-branch" },
    ]);

    const yaml = await readFile(service.file, "utf8");
    for (const gone of ["authority:", "ships:", "fullAccess", "tidy", "acme-lead", "[initech]"]) {
      expect(yaml).not.toContain(gone);
    }
    // A second run finds nothing and writes nothing.
    expect(await service.migrateLevels({ orgOfTask: (task) => TASKS[task] })).toBe(false);
  });

  it("leaves a file with nothing from before alone, so a workspace made later keeps the default", async () => {
    await writeFile(
      service.file,
      [
        "workspaces: [~/Work]",
        "orgs:",
        "  acme: { name: Acme }",
        "autonomy:",
        "  orgs:",
        "    globex: { level: full }",
        "",
      ].join("\n"),
    );
    expect(await service.migrateLevels({ orgOfTask: () => undefined })).toBe(false);
    expect((await service.settings()).autonomy.orgs).toEqual({ globex: { level: "full" } });
  });
});
