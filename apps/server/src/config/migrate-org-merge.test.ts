import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AutonomySettingsSchema } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { authorityOf } from "../captain/levels.ts";
import { type Harness, harness } from "../testing/harness.ts";
import { foldedOrgs } from "./migrate-org-merge.ts";

let h: Harness;
afterEach(() => h?.cleanup());

/**
 * What the captain did with a workspace's merges before: the org's own switch decided its merge requests
 * (`auto-if-green` merged them by itself, once CI passed). It folds into the workspace's level now.
 */
describe("folding the org merge switch into the level", () => {
  it("makes a workspace Full only where the owner said majhi merges by itself, and leaves the rest alone", () => {
    const autonomy = AutonomySettingsSchema.parse({
      orgs: { acme: { level: "routine", cap: { cost: 5 } }, globex: { level: "ask" } },
    });
    const orgs = foldedOrgs(autonomy, [
      { id: "acme", policy: "auto-if-green" },
      { id: "globex", policy: "approve" },
      { id: "northwind", policy: "never" },
    ]);
    expect(orgs?.acme).toEqual({ level: "full", cap: { cost: 5 } });
    expect(orgs?.globex).toEqual({ level: "ask" });
    expect(orgs).not.toHaveProperty("northwind");
  });

  it("changes nothing when no switch moves a level", () => {
    const autonomy = AutonomySettingsSchema.parse({ orgs: { acme: { level: "full" } } });
    expect(foldedOrgs(autonomy, [{ id: "acme", policy: "auto-if-green" }])).toBeUndefined();
    expect(foldedOrgs(autonomy, [{ id: "acme", policy: "approve" }])).toBeUndefined();
  });
});

describe("the migration of a majhi.yaml", () => {
  it("moves auto-if-green into the level, removes every old switch, keeps what else the org says, and runs once", async () => {
    h = await harness({ workspaces: false });
    const file = join(h.env.majhiHome, "majhi.yaml");
    await writeFile(
      file,
      [
        "workspaces: [~/Work]",
        "orgs:",
        "  acme: { name: Acme, merge: auto-if-green, lead_start: org }",
        "  globex: { name: Globex, merge: never }",
        "  initech: { name: Initech }",
        "autonomy:",
        "  orgs:",
        "    acme: { authority: { start: ask, questions: ask, approvals: ask, upkeep: decide, merge: ask, push: ask, own: ask } }",
        "",
      ].join("\n"),
    );
    const service = h.majhi.services.config;
    expect(await service.migrateOrgMerge()).toBe(true);
    const yaml = await readFile(file, "utf8");
    expect(yaml).not.toContain("auto-if-green");
    expect(yaml).not.toMatch(/merge: never/);
    expect(yaml).toContain("lead_start: org");
    const { autonomy } = await service.settings();
    expect(authorityOf(autonomy, "acme").merge).toBe("decide");
    expect(authorityOf(autonomy, "acme").upkeep).toBe("decide");
    expect(authorityOf(autonomy, "globex").merge).toBe("ask");
    expect(await service.migrateOrgMerge()).toBe(false);
  });
});
