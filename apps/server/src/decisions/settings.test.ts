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
  it("defaults the floors to 0.4 and the tiers to the role defaults", async () => {
    const s = await read("workspaces: [/Users/owner/Work]\n");
    expect(s).toMatchObject({ min_confidence: 0.6, model_floor: 0.4, effort_floor: 0.4 });
    expect(s.tiers).toEqual(DEFAULT_TIERS);
  });

  it("merges the tiers the file sets over the defaults, per part", async () => {
    const s = await read(
      "decisions:\n  model_floor: 0.5\n  tiers:\n    Builder:\n      effort: highest\n    Tester:\n      model: balanced\n      effort: middle\n",
    );
    expect(s.model_floor).toBe(0.5);
    expect(s.effort_floor).toBe(0.4);
    expect(s.tiers.Builder).toEqual({ model: "balanced", effort: "highest" });
    expect(s.tiers.Tester).toEqual({ model: "balanced", effort: "middle" });
    expect(s.tiers.Lead).toEqual(DEFAULT_TIERS.Lead);
  });

  it("rejects a bad tier or floor in a patch", () => {
    expect(DecisionPatchSchema.safeParse({ tiers: { Lead: { model: "best" } } }).success).toBe(false);
    expect(DecisionPatchSchema.safeParse({ tiers: { Boss: { model: "cheapest" } } }).success).toBe(false);
    expect(DecisionPatchSchema.safeParse({ effort_floor: 1.5 }).success).toBe(false);
  });
});

describe("resolveTier", () => {
  it("takes each part from the first layer that sets it", () => {
    expect(resolveTier("Lead")).toEqual({ model: "most-capable", effort: "highest" });
    expect(resolveTier("Lead", { effort: "lowest" }, { model: "cheapest", effort: "middle" })).toEqual({
      model: "cheapest",
      effort: "lowest",
    });
    expect(resolveTier("Tester", undefined, undefined)).toEqual(DEFAULT_TIERS.Tester);
  });
});
