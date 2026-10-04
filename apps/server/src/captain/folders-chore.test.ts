import { ALL_ASK, type Authority, type CaptainChore } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { createChores } from "./chores.ts";
import type { CaptainPorts } from "./ports.ts";
import { CaptainRepo } from "./repo.ts";
import { ChoreRunner, type RunnerDeps } from "./runner.ts";

/** The cleanup chore's disk step, through the real runner: the log line, a second run, a failure. */

const NOW = new Date("2026-10-04T12:00:00.000Z");

function setup(ports: Partial<CaptainPorts>) {
  const repo = new CaptainRepo(new Store(":memory:").raw);
  const chores = createChores({ cleanable: async () => [], ...ports } as unknown as CaptainPorts, () => NOW);
  const runner = new ChoreRunner({
    repo,
    now: () => NOW,
    workspace: async () => ({
      org: "acme",
      name: "Acme",
      // Autonomous is off: cleanup still runs.
      mode: "off",
      authority: { ...ALL_ASK, upkeep: "decide" } as Authority,
      rules: undefined,
      tz: "UTC",
      day: "2026-10-04",
    }),
    stopped: () => false,
    tellOwner: () => {},
    laneTokens: () => 0,
    chores: chores as RunnerDeps["chores"],
  });
  return { repo, runner };
}

describe("the cleanup chore frees disk in done tasks", () => {
  it("logs the bytes it freed, once per state, even while Autonomous is off", async () => {
    let left = 3_400_000_000;
    const t = setup({
      foldersFreeable: async () => ({ bytes: left, tasks: 2 }),
      freeFolders: async () => {
        const freed = left;
        left = 0;
        return { bytes: freed, tasks: [{ id: "ACM-1", bytes: freed, worktrees: 0, folders: 4 }] };
      },
    });
    expect(await t.runner.start("acme", "cleanup" satisfies CaptainChore, "daily")).toBe("done");
    expect(t.repo.allActions()).toEqual([
      expect.objectContaining({
        outcome: "done",
        chore: "cleanup",
        text: "Freed 3.4 GB in 1 done task: ACM-1 3.4 GB",
      }),
    ]);
    // A second run finds nothing left to free and adds no line.
    expect(await t.runner.start("acme", "cleanup", "daily")).toBe("done");
    expect(t.repo.allActions()).toHaveLength(1);
  });

  it("logs nothing when there is nothing to free, and a failure as a failed line", async () => {
    const quiet = setup({ foldersFreeable: async () => ({ bytes: 0, tasks: 0 }) });
    await quiet.runner.start("acme", "cleanup", "daily");
    expect(quiet.repo.allActions()).toEqual([]);

    const broken = setup({
      foldersFreeable: async () => ({ bytes: 1_000_000, tasks: 1 }),
      freeFolders: async () => {
        throw new Error("disk is read-only");
      },
    });
    await broken.runner.start("acme", "cleanup", "daily");
    expect(broken.repo.allActions()).toEqual([
      expect.objectContaining({ outcome: "failed", text: expect.stringContaining("disk is read-only") }),
    ]);
  });
});
