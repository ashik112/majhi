import type { Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { FULL } from "../captain/authority-fixtures.ts";
import { createChores } from "../captain/chores.ts";
import type { CaptainPorts, DeployPorts } from "../captain/ports.ts";
import { CaptainRepo } from "../captain/repo.ts";
import { ChoreRunner, type Workspace } from "../captain/runner.ts";
import { Store } from "../store/index.ts";
import { BLOCKS, type BlockKind } from "./blocked.ts";
import { waitingDeployDecisions } from "./decisions.ts";
import type { SyncHead } from "./git.ts";
import { DeployPlanner } from "./plan.ts";
import type { DeployService, Evaluated } from "./service.ts";
import { heldSteps } from "./sync.ts";
import { C2, GH, type Rig, rig } from "./testing/rig.ts";

/**
 * Every reason a planned step cannot go on has an outcome the owner can see: a card in Needs you, a line in the captain's
 * log, or a state on the task's trail. Read through the planner, the cards and the real chore, never from the table.
 */

const NOW = () => new Date("2026-10-23T10:00:00.000Z");
let rigged: Rig | undefined;
afterEach(async () => {
  await rigged?.service.idle();
  await rigged?.hosts.close();
  rigged?.store.close();
  rigged = undefined;
});

const SYNC: SyncHead = {
  kind: "sync",
  base: "main",
  sourceRemote: "origin",
  deployRemote: "gitlab",
  sourceTip: "a".repeat(40),
  deployTip: "b".repeat(40),
  deployOnly: 3,
  deployOnlyLines: ["b1b1b1b fix the slip total"],
  sourceOnly: 20,
  conflicts: ["app.txt"],
};

const task = {
  id: "ACM-1",
  title: "Globex cannot print slips",
  status: "done",
  team: ["acme-builder"],
  repos: [
    {
      project: "storefront",
      branch: "task/slips",
      landed: { commit: C2, into: "main", at: "2026-10-23T09:00:00.000Z" },
    },
  ],
} as unknown as Task;

/** What the owner sees for a step the deploy refused with `kind`. */
async function outcomeOf(kind: BlockKind): Promise<"card" | "line" | "state" | "nothing"> {
  await rigged?.service.idle();
  await rigged?.hosts.close();
  rigged?.store.close();
  rigged = await rig([{ env: "production", tier: "production", check: "https://acme.example/health" }]);
  await rigged.service.plan(
    { task: "ACM-1", steps: [{ project: "storefront", env: "production", runs: GH }] },
    "captain",
  );
  const refused = {
    ok: false,
    kind,
    why: `The ${kind} reason`,
    ...(kind === "sync" ? { sync: SYNC } : {}),
    ...(kind === "unpushed" ? { commit: C2 } : {}),
  } as Evaluated;
  const planner = new DeployPlanner({
    service: { evaluate: async () => refused } as Pick<DeployService, "evaluate">,
    repo: rigged.store.deploys,
    ship: async () =>
      ({ steps: { deployStaging: "owner", deployProduction: "owner" }, rest: undefined, facts: {} }) as never,
    environments: async () => rigged?.project.environments ?? [],
  });
  const steps = await planner.stepsOf(task);
  const first = steps[0];
  if (first === undefined) return "nothing";

  const cards = waitingDeployDecisions([{ task: "ACM-1", steps }], () => ({
    title: task.title,
    updatedAt: "2026-10-23T09:00:00.000Z",
  }));
  if (cards.length > 0) return "card";

  const repo = new CaptainRepo(new Store(":memory:").raw);
  const ws = (): Workspace => ({
    org: "acme",
    name: "Acme",
    mode: "on",
    authority: FULL,
    rules: {},
    tz: "UTC",
    day: "2026-10-23",
    rulesOff: new Set(),
  });
  const runner = new ChoreRunner({
    repo,
    now: NOW,
    workspace: async () => ws(),
    stopped: () => false,
    tellOwner: () => undefined,
    laneTokens: () => 0,
    chores: createChores(
      {
        typing: () => false,
        answerTasks: async () => [],
        reviewTasks: async () => [],
        deploys: {
          needsPlan: async () => undefined,
          next: async () => [],
          held: async () => heldSteps(task, steps),
          prepare: async () => undefined,
          recheck: async () => undefined,
          deploy: async () => {
            throw new Error("nothing deploys here");
          },
        } as unknown as DeployPorts,
      } as unknown as CaptainPorts,
      NOW,
    ),
  });
  const started = await runner.startNow("acme", "ship");
  if (started.ran) await started.done;
  if (repo.allActions().some((a) => a.task === "ACM-1")) return "line";
  return first.state === "waits-for-previous" ? "state" : "nothing";
}

describe("a planned deploy step that cannot go on", () => {
  it("is a card for the owner or a line in the captain's log, never nothing", async () => {
    const kinds = Object.keys(BLOCKS) as BlockKind[];
    const outcomes: Record<string, string> = {};
    for (const kind of kinds) outcomes[kind] = await outcomeOf(kind);
    expect(outcomes).toEqual({
      // Only the owner can clear these: one card with the reason and the one thing to do.
      setup: "card",
      unreadable: "card",
      unverified: "card",
      unpushed: "card",
      // majhi clears these: a line in the captain's log (a deploy remote that is ahead wakes the task's own agent).
      moved: "line",
      rest: "line",
      sync: "line",
      // The step before it is not live yet: the plan goes on by itself, and the trail says it waits.
      previous: "state",
    });
  });
});
