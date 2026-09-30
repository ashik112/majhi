import { describe, expect, it } from "vitest";
import { difficultyQuestion, tierForDifficulty } from "./difficulty.ts";

describe("tierForDifficulty", () => {
  it("moves the role's tiers at most one step, and never past the ends", () => {
    const builder = { model: "balanced", effort: "middle" } as const;
    expect(tierForDifficulty(builder, "trivial")).toEqual({ model: "cheapest", effort: "lowest" });
    expect(tierForDifficulty(builder, "small")).toEqual({ model: "balanced", effort: "lowest" });
    expect(tierForDifficulty(builder, "medium")).toEqual(builder);
    expect(tierForDifficulty(builder, "large")).toEqual({ model: "most-capable", effort: "highest" });

    const lead = { model: "most-capable", effort: "highest" } as const;
    expect(tierForDifficulty(lead, "large")).toEqual(lead);
    expect(tierForDifficulty(lead, "trivial")).toEqual({ model: "balanced", effort: "middle" });

    const tester = { model: "cheapest", effort: "lowest" } as const;
    expect(tierForDifficulty(tester, "trivial")).toEqual(tester);
    expect(tierForDifficulty(tester, "large")).toEqual({ model: "balanced", effort: "middle" });
  });
});

describe("difficultyQuestion", () => {
  it("sends the task as named fields and does not repeat the title", () => {
    const q = difficultyQuestion({
      title: "Add a health endpoint",
      brief: "Add a health endpoint\nGET /health returns ok.",
      kind: "code",
      repos: [],
      role: "Tester",
    });
    expect(q.state).toEqual({
      task: "Add a health endpoint",
      description: "GET /health returns ok.",
      kind: "code",
      repos: "none",
      role: "Tester, who runs and checks the results",
    });
  });
});
