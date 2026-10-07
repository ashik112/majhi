import type { DeployRecord } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { RUNS } from "./authority-fixtures.ts";
import { createChores } from "./chores.ts";
import type { CaptainPorts, DeployNext } from "./ports.ts";
import { CaptainRepo } from "./repo.ts";
import { ChoreRunner, type Workspace } from "./runner.ts";

/** What the ship chore does with merged work that has a deploy target. */

const NOW = () => new Date("2026-10-07T10:00:00.000Z");
const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

const step = (over: Partial<DeployNext> = {}): DeployNext => ({
  task: "ACM-142",
  title: "Checkout fails when a coupon takes more than 50% off",
  project: "storefront",
  env: "staging",
  commit: COMMIT,
  who: "captain",
  rule: "A bug up to 200 lines",
  ...over,
});

function setup(
  steps: DeployNext[],
  over: { stillNext?: () => string | undefined; rulesOff?: string[] } = {},
) {
  const repo = new CaptainRepo(new Store(":memory:").raw);
  const started: string[] = [];
  const ports = {
    typing: () => false,
    answerTasks: async () => [],
    reviewTasks: async () => [],
    deploys: {
      next: async () => steps,
      recheck: async () => over.stillNext?.(),
      deploy: async (_org: string, s: DeployNext) => {
        started.push(`${s.project}:${s.env}`);
        return { record: { id: 5 } as DeployRecord, repeat: false };
      },
    },
  } as unknown as CaptainPorts;
  const ws = (): Workspace => ({
    org: "acme",
    name: "Acme",
    mode: "on",
    authority: RUNS,
    rules: undefined,
    tz: "UTC",
    day: "2026-10-07",
    rulesOff: new Set(over.rulesOff ?? []),
  });
  const runner = new ChoreRunner({
    repo,
    now: NOW,
    workspace: async () => ws(),
    stopped: () => false,
    tellOwner: () => undefined,
    laneTokens: () => 0,
    chores: createChores(ports, NOW),
  });
  const run = async () => {
    const r = await runner.startNow("acme", "ship");
    if (r.ran) await r.done;
  };
  return { run, started, repo };
}

describe("deploying merged work", () => {
  it("starts the deploy the rules give the captain once, and offers Roll back instead of Undo", async () => {
    const t = setup([step()]);
    await t.run();
    await t.run();
    expect(t.started).toEqual(["storefront:staging"]);
    const [action] = t.repo.allActions();
    expect(action?.text).toContain("Started the deploy of storefront to staging");
    expect(action?.reason).toBe("In Acme the rule for a bug up to 200 lines lets the captain deploy staging");
    expect(action?.undoData).toEqual({ kind: "rollback", record: 5 });
    expect(action?.undoWord).toBe("roll-back");
  });

  it("leaves a deploy that is the owner's for them, and says so once", async () => {
    const t = setup([step({ env: "production", who: "owner" })]);
    await t.run();
    await t.run();
    expect(t.started).toEqual([]);
    const actions = t.repo.allActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ outcome: "asked" });
    expect(actions[0]?.reason).toBe(
      "In Acme the rule for a bug up to 200 lines leaves Deploy production to you",
    );
  });

  it("does not deploy when a guard no longer lets it go, read right before the step", async () => {
    const t = setup([step()], { stillNext: () => "The base branch is at 9f8e7d6 now, not at a1b2c3d." });
    await t.run();
    expect(t.started).toEqual([]);
    expect(t.repo.allActions().find((a) => a.outcome === "done")).toBeUndefined();
  });

  it("deploys nothing while the owner switched the playbook rule off", async () => {
    const t = setup([step()], { rulesOff: ["ship-deploy"] });
    await t.run();
    expect(t.started).toEqual([]);
  });
});
