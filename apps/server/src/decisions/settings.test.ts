import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TIERS, DecisionPatchSchema, resolveTier } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { readDecisionSettings } from "./settings.ts";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function read(yaml: string) {
  dir = await mkdtemp(join(tmpdir(), "majhi-decisions-"));
  const file = join(dir, "majhi.yaml");
  await writeFile(file, yaml);
  return readDecisionSettings(file);
}

describe("readDecisionSettings", () => {
  it("defaults the answer bar to 0.2 over chance and 0.05 ahead, and the tiers to the role defaults", async () => {
    const s = await read("workspaces: [/Users/owner/Work]\n");
    expect(s).toMatchObject({ min_lift: 0.2, min_margin: 0.05 });
    expect(s.tiers).toEqual(DEFAULT_TIERS);
  });

  it("still loads a file with the old fixed floors, keeping everything else it sets", async () => {
    const s = await read(
      "decisions:\n  order: [acp, rules]\n  min_confidence: 0.7\n  model_floor: 0.5\n  effort_floor: 0.3\n  per_run_limit: 9\n",
    );
    expect(s).toMatchObject({ order: ["acp", "rules"], per_run_limit: 9, min_lift: 0.2, min_margin: 0.05 });
  });

  it("merges the tiers the file sets over the defaults, per part", async () => {
    const s = await read(
      "decisions:\n  min_lift: 0.3\n  tiers:\n    Builder:\n      effort: highest\n    Tester:\n      model: balanced\n      effort: middle\n",
    );
    expect(s.min_lift).toBe(0.3);
    expect(s.min_margin).toBe(0.05);
    expect(s.tiers.Builder).toEqual({ model: "balanced", effort: "highest" });
    expect(s.tiers.Tester).toEqual({ model: "balanced", effort: "middle" });
    expect(s.tiers.Lead).toEqual(DEFAULT_TIERS.Lead);
  });

  it("rejects a bad tier or floor in a patch", () => {
    expect(DecisionPatchSchema.safeParse({ tiers: { Lead: { model: "best" } } }).success).toBe(false);
    expect(DecisionPatchSchema.safeParse({ tiers: { Boss: { model: "cheapest" } } }).success).toBe(false);
    expect(DecisionPatchSchema.safeParse({ min_lift: 1.5 }).success).toBe(false);
  });
});

describe("resolveTier", () => {
  it("takes each part from the first layer that sets it", () => {
    expect(resolveTier("Lead")).toEqual(DEFAULT_TIERS.Lead);
    expect(resolveTier("Lead", { effort: "lowest" }, { model: "cheapest", effort: "middle" })).toEqual({
      model: "cheapest",
      effort: "lowest",
    });
    expect(resolveTier("Tester", undefined, undefined)).toEqual(DEFAULT_TIERS.Tester);
  });
});
