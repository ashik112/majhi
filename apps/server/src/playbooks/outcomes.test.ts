import type { Authority } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
import { createChores } from "../captain/chores.ts";
import type { CaptainPorts } from "../captain/ports.ts";
import { CaptainRepo } from "../captain/repo.ts";
import { ChoreRunner, type Workspace } from "../captain/runner.ts";
import { Store } from "../store/index.ts";

/** An outcome rule the owner switched off really stops its action, and a made playbook starts off. */

function ship(merge: "decide" | "ask", off: string[]) {
  const store = new Store(":memory:");
  const repo = new CaptainRepo(store.raw);
  const calls = { merged: 0, asked: 0 };
  // Only the ports the ship chore reads; the rest is never called by it.
  const ports = {
    typing: () => false,
    answerTasks: async () => [],
    reviewTasks: async () => [{ id: "ACM-1", title: "Add export", heads: "abc" }],
    shipCheck: async () => ({
      ready: true,
      evidence: "checks pass",
      targets: [{ into: "main", base: "main" }],
    }),
    ship: async () => {
      calls.merged += 1;
      return { text: "Shipped ACM-1" };
    },
    shipReady: async () => {
      calls.asked += 1;
    },
  } as unknown as CaptainPorts;
  const now = () => new Date("2026-10-04T10:00:00.000Z");
  const authority: Authority = { ...RUNS, merge };
  const ws = (): Workspace => ({
    org: "acme",
    name: "Acme",
    mode: "on",
    authority,
    rules: undefined,
    tz: "UTC",
    day: "2026-10-04",
    rulesOff: new Set(off),
  });
  const runner = new ChoreRunner({
    repo,
    now,
    workspace: async () => ws(),
    stopped: () => false,
    tellOwner: () => undefined,
    laneTokens: () => 0,
    chores: createChores(ports, now),
  });
  return { runner, calls };
}

describe("outcome rules of Ship finished work", () => {
  it("merges when Merge is Captain and the rule is on", async () => {
    const t = ship("decide", []);
    const r = await t.runner.startNow("acme", "ship");
    if (r.ran) await r.done;
    expect(t.calls).toEqual({ merged: 1, asked: 0 });
  });

  it("does not merge when its rule is off", async () => {
    const t = ship("decide", ["ship-merge"]);
    const r = await t.runner.startNow("acme", "ship");
    if (r.ran) await r.done;
    expect(t.calls).toEqual({ merged: 0, asked: 0 });
  });

  it("asks you when Merge is You, and stops asking when that rule is off", async () => {
    const on = ship("ask", []);
    const a = await on.runner.startNow("acme", "ship");
    if (a.ran) await a.done;
    expect(on.calls).toEqual({ merged: 0, asked: 1 });

    const off = ship("ask", ["ship-ask"]);
    const b = await off.runner.startNow("acme", "ship");
    if (b.ran) await b.done;
    expect(off.calls).toEqual({ merged: 0, asked: 0 });
  });
});

/** One chore run with the given ports and switches off, and the lines it wrote to the captain's log. */
async function choreRun(
  chore: "ship" | "cards" | "triage" | "cleanup" | "questions" | "projects",
  ports: Record<string, unknown>,
  off: string[],
  authority: Authority = RUNS,
): Promise<string[]> {
  const store = new Store(":memory:");
  const repo = new CaptainRepo(store.raw);
  const now = () => new Date("2026-10-04T10:00:00.000Z");
  const all = {
    typing: () => false,
    answerTasks: async () => [],
    ...ports,
  } as unknown as CaptainPorts;
  const runner = new ChoreRunner({
    repo,
    now,
    workspace: async () => ({
      org: "acme",
      name: "Acme",
      mode: "on",
      authority,
      rules: undefined,
      tz: "UTC",
      day: "2026-10-04",
      rulesOff: new Set(off),
    }),
    stopped: () => false,
    tellOwner: () => undefined,
    laneTokens: () => 0,
    chores: createChores(all, now),
  });
  const r = await runner.startNow("acme", chore);
  if (r.ran) await r.done;
  return repo.allActions().map((a) => a.text);
}

describe("outcome rules of the other chores", () => {
  it("asks about uncommitted work and never removes it, and removes a clean worktree only while its rule is on", async () => {
    const cleaned: string[] = [];
    const ports = {
      cleanable: async () => [
        { id: "ACM-1", title: "Old", steps: ["worktree /w/ACM-1"], dirty: [] },
        { id: "ACM-2", title: "Dirty", steps: [], dirty: ["/w/ACM-2: it has uncommitted changes (2 files)"] },
      ],
      clean: async (_o: string, id: string) => {
        cleaned.push(id);
        return { removed: [], kept: [] };
      },
    };
    const lines = await choreRun("cleanup", ports, []);
    expect(cleaned).toEqual(["ACM-1"]);
    expect(lines.some((l) => l.startsWith("Left ACM-2 for you"))).toBe(true);
    cleaned.length = 0;
    const quiet = await choreRun("cleanup", ports, ["cleanup-worktrees", "cleanup-ask"]);
    expect(cleaned).toEqual([]);
    expect(quiet).toEqual([]);
  });

});
