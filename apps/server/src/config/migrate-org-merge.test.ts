import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ALL_ASK, AutonomySettingsSchema } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { authorityOf } from "../captain/levels.ts";
import { type Harness, harness } from "../testing/harness.ts";
import { foldedMergeRow, foldedOrgs, type OldMergePolicy } from "./migrate-org-merge.ts";

let h: Harness;
afterEach(() => h?.cleanup());

/**
 * What the captain did with a workspace's merges before: the Merge row decided its local merges, and the
 * org's own switch decided its merge requests (`auto-if-green` merged them by itself, once CI passed).
 */
describe("folding the org merge switch into the Merge row", () => {
  const cases: { policy: OldMergePolicy; row: "ask" | "decide"; after: "ask" | "decide" }[] = [
    { policy: "never", row: "ask", after: "ask" },
    { policy: "never", row: "decide", after: "decide" },
    { policy: "approve", row: "ask", after: "ask" },
    { policy: "approve", row: "decide", after: "decide" },
    { policy: "auto-if-green", row: "ask", after: "decide" },
    { policy: "auto-if-green", row: "decide", after: "decide" },
  ];

  it.each(cases)("$policy with the row on $row becomes $after", ({ policy, row, after }) => {
    expect(foldedMergeRow(policy, row)).toBe(after);
  });

  it("never takes a merge away from the captain, and widens only where the owner said majhi merges by itself", () => {
    for (const { policy, row, after } of cases) {
      if (row === "decide") expect(after).toBe("decide");
      if (after === "decide" && row === "ask") expect(policy).toBe("auto-if-green");
    }
  });

  it("writes the full rows for a workspace it changes, keeps every other row, and leaves the rest alone", () => {
    const autonomy = AutonomySettingsSchema.parse({
      orgs: {
        acme: { authority: { ...ALL_ASK, start: "decide", push: "decide" } },
        globex: { level: "runs" },
      },
    });
    const orgs = foldedOrgs(autonomy, [
      { id: "acme", policy: "auto-if-green" },
      { id: "globex", policy: "approve" },
      { id: "northwind", policy: "never" },
    ]);
    expect(orgs?.acme?.authority).toEqual({ ...ALL_ASK, start: "decide", push: "decide", merge: "decide" });
    // A workspace whose row does not change keeps its entry exactly as it was.
    expect(orgs?.globex).toEqual(autonomy.orgs.globex);
    expect(orgs).not.toHaveProperty("northwind");
    expect(authorityOf({ orgs: orgs ?? {} }, "acme").merge).toBe("decide");
  });

  it("changes nothing when no switch moves a row", () => {
    const autonomy = AutonomySettingsSchema.parse({ orgs: { acme: { authority: { ...ALL_ASK } } } });
    expect(foldedOrgs(autonomy, [{ id: "acme", policy: "approve" }])).toBeUndefined();
  });
});

describe("the migration of a majhi.yaml", () => {
  it("moves auto-if-green into the row, removes every old switch, keeps what else the org says, and runs once", async () => {
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
