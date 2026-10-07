import {
  ALL_ASK,
  AutonomySettingsSchema,
  type DeployEnvironment,
  type ShipRule,
  type Task,
} from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { ownerStepOf } from "../tasks/detail.ts";
import { linesOfNumstat } from "./lines.ts";
import { opensMergeRequest, ShipPlanner } from "./plan.ts";

const rule: ShipRule = {
  id: "aaaaaaaa",
  when: { types: ["bug"] },
  merge: "decide",
  deployStaging: "ask",
  deployProduction: "ask",
  tell: "ask",
};

const task = (id: string, org: string | undefined, type: "bug" | "feature", into?: string): Task =>
  ({
    id,
    org,
    status: "review",
    repos: into === undefined ? [] : [{ project: "storefront", base: into, branch: "task/x" }],
    typing: { type, by: "owner" },
  }) as unknown as Task;

function planner(
  mode: "on" | "off",
  way: "local" | "merge-request" = "local",
  environments: DeployEnvironment[] = [],
  into?: string,
) {
  const tasks = new Map<string, Task>([
    ["ACM-1", task("ACM-1", "acme", "bug", into)],
    ["ACM-2", task("ACM-2", "acme", "feature")],
    ["GLX-1", task("GLX-1", "globex", "bug")],
  ]);
  return new ShipPlanner({
    tasks: { get: (id) => tasks.get(id) },
    settings: async () =>
      AutonomySettingsSchema.parse({
        orgs: {
          acme: { authority: { ...ALL_ASK }, ships: [rule] },
          globex: { authority: { ...ALL_ASK } },
        },
      }),
    mode: () => mode,
    areas: { of: async () => ({ areas: [], unmapped: 0 }), forget: () => undefined },
    environments: async () => environments,
    viaMergeRequests: async () => way === "merge-request",
    zone: () => "UTC",
    now: () => new Date("2026-10-04T10:00:00.000Z"),
  });
}

describe("who ships a task", () => {
  it("applies a workspace's rules to its own tasks only", async () => {
    const p = planner("on");
    expect((await p.plan("ACM-1")).steps.merge).toBe("captain");
    // Another workspace's bug is not covered by Acme's rule.
    expect((await p.plan("GLX-1")).steps.merge).toBe("owner");
    // Neither is a task of Acme the rule does not name.
    expect((await p.plan("ACM-2")).steps.merge).toBe("owner");
  });

  it("is the owner's everywhere while Autonomous is off", async () => {
    expect((await planner("off").plan("ACM-1")).steps.merge).toBe("owner");
  });

  it("says how the task lands, and names the rule that decided", async () => {
    const plan = await planner("on", "merge-request").plan("ACM-1");
    expect(plan.way).toBe("merge-request");
    expect(plan.ruleSubject).toBe("A bug");
  });
});

describe("a merge into the branch of an environment", () => {
  const deployOnMain = (tier: "production" | "staging"): DeployEnvironment[] => [
    { env: "production", tier, branch: "main" },
  ];

  it("takes the stricter of Merge and the tier's Deploy cell, so the owner's Deploy production keeps the merge", async () => {
    // The rule gives the captain the merge and leaves both Deploy cells to the owner.
    const plan = await planner("on", "local", deployOnMain("production"), "main").plan("ACM-1");
    expect(plan.steps.merge).toBe("owner");
    expect(plan.steps.push).toBe("owner");
    expect(plan.gated).toEqual({ project: "storefront", env: "production", tier: "production" });
  });

  it("leaves the merge alone when the branch is no environment's, and when the tier's Deploy cell is the captain's", async () => {
    expect(
      (await planner("on", "local", deployOnMain("production"), "develop").plan("ACM-1")).steps.merge,
    ).toBe("captain");
    const open: ShipRule = { ...rule, deployStaging: "decide" };
    const p = new ShipPlanner({
      tasks: { get: () => task("ACM-1", "acme", "bug", "main") },
      settings: async () =>
        AutonomySettingsSchema.parse({ orgs: { acme: { authority: { ...ALL_ASK }, ships: [open] } } }),
      mode: () => "on",
      areas: { of: async () => ({ areas: [], unmapped: 0 }), forget: () => undefined },
      environments: async () => deployOnMain("staging"),
      viaMergeRequests: async () => false,
      zone: () => "UTC",
      now: () => new Date("2026-10-04T10:00:00.000Z"),
    });
    const plan = await p.plan("ACM-1");
    expect(plan.steps.merge).toBe("captain");
    expect(plan.gated).toBeUndefined();
  });
});

describe("the step that waits for the owner", () => {
  const code = { repos: [{ project: "api" }] } as unknown as Task;
  const steps = (merge: "captain" | "owner", push: "captain" | "owner") =>
    ({
      merge,
      push,
      deployStaging: "owner",
      deployProduction: "owner",
      tell: "owner",
      rule: undefined,
    }) as const;

  it("is the merge when it is the owner's, unless the captain opens a merge request first", () => {
    expect(ownerStepOf(code, { steps: steps("owner", "owner"), way: "local" })).toBe("merge");
    expect(ownerStepOf(code, { steps: steps("owner", "captain"), way: "local" })).toBeUndefined();
  });

  it("is the push when the project works through merge requests and only the merge is the captain's", () => {
    expect(ownerStepOf(code, { steps: steps("captain", "owner"), way: "merge-request" })).toBe("push");
    expect(ownerStepOf(code, { steps: steps("captain", "owner"), way: "local" })).toBeUndefined();
    expect(ownerStepOf(code, { steps: steps("captain", "captain"), way: "merge-request" })).toBeUndefined();
  });

  it("is nothing for a task that changed no code", () => {
    expect(
      ownerStepOf({ repos: [] } as unknown as Task, { steps: steps("owner", "owner"), way: "local" }),
    ).toBeUndefined();
  });

  it("opens a merge request when Push is the captain's and Merge is the owner's, or the project works through them", () => {
    expect(opensMergeRequest({ steps: steps("owner", "captain"), way: "local" })).toBe(true);
    expect(opensMergeRequest({ steps: steps("captain", "captain"), way: "merge-request" })).toBe(true);
    expect(opensMergeRequest({ steps: steps("captain", "captain"), way: "local" })).toBe(false);
    expect(opensMergeRequest({ steps: steps("captain", "owner"), way: "merge-request" })).toBe(false);
  });
});

describe("the size of a change", () => {
  it("adds the added and removed lines, and does not know a binary file's size", () => {
    expect(linesOfNumstat("3\t1\ta.ts\n10\t0\tb.ts\n")).toBe(14);
    expect(linesOfNumstat("")).toBe(0);
    expect(linesOfNumstat("3\t1\ta.ts\n-\t-\tlogo.png\n")).toBeUndefined();
  });
});
