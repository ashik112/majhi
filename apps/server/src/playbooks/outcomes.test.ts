import { type Authority, PRIVATE } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
import { createChores } from "../captain/chores.ts";
import type { CaptainPorts } from "../captain/ports.ts";
import { CaptainRepo } from "../captain/repo.ts";
import { ChoreRunner, type Workspace } from "../captain/runner.ts";
import { type FindingSpec, file, reporterOf } from "../sensors/ports.ts";
import { Store } from "../store/index.ts";
import { Catalog } from "./catalog.ts";
import { PlaybookRepo } from "./repo.ts";
import { isRuleOn, type RulesContext } from "./rules.ts";
import { PlaybookService } from "./service.ts";

/** An outcome rule the owner switched off really stops its action, and a made playbook starts off. */

function ship(merge: "decide" | "ask", off: string[]) {
  const store = new Store(":memory:");
  const repo = new CaptainRepo(store.raw);
  const calls = { merged: 0, asked: 0 };
  // Only the ports the ship chore reads; the rest is never called by it.
  const ports = {
    typing: () => false,
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
    caused: () => undefined,
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
  chore: "ship" | "cards" | "stuck" | "triage" | "cleanup" | "questions" | "projects",
  ports: Record<string, unknown>,
  off: string[],
  authority: Authority = RUNS,
): Promise<string[]> {
  const store = new Store(":memory:");
  const repo = new CaptainRepo(store.raw);
  const now = () => new Date("2026-10-04T10:00:00.000Z");
  const all = { typing: () => false, signInStalls: async () => [], ...ports } as unknown as CaptainPorts;
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
    caused: () => undefined,
    laneTokens: () => 0,
    chores: createChores(all, now),
  });
  const r = await runner.startNow("acme", chore);
  if (r.ran) await r.done;
  return repo.allActions().map((a) => a.text);
}

describe("outcome rules of the other chores", () => {
  const conflicted = {
    reviewTasks: async () => [{ id: "ACM-1", title: "Add export", heads: "abc" }],
    shipCheck: async () => ({ ready: false, why: "it conflicts with main in a.txt", conflict: true }),
  };

  it("asks the lead to resolve a conflict where Merge is Captain, and not when its rule is off", async () => {
    const asked: string[] = [];
    const ports = { ...conflicted, resolveShip: async (_o: string, id: string) => void asked.push(id) };
    await choreRun("ship", ports, [], { ...RUNS, merge: "decide" });
    expect(asked).toEqual(["ACM-1"]);
    await choreRun("ship", ports, ["ship-conflict"], { ...RUNS, merge: "decide" });
    expect(asked).toEqual(["ACM-1"]);
  });

  it("leaves a conflict to the owner where Merge is You", async () => {
    const asked: string[] = [];
    const ports = { ...conflicted, resolveShip: async (_o: string, id: string) => void asked.push(id) };
    const lines = await choreRun("ship", ports, [], { ...RUNS, merge: "ask" });
    expect(asked).toEqual([]);
    expect(lines.some((l) => l.includes("not ready to ship"))).toBe(true);
  });

  it("does not note why a task is not ready when that rule is off", async () => {
    const ports = {
      reviewTasks: async () => [{ id: "ACM-1", title: "Add export", heads: "abc" }],
      shipCheck: async () => ({ ready: false, why: "Acme-api has uncommitted changes" }),
    };
    expect((await choreRun("ship", ports, [])).length).toBe(1);
    expect(await choreRun("ship", ports, ["ship-notready"])).toEqual([]);
  });

  it("leaves a risky card with the reason, and an unclear one by a different rule", async () => {
    const decided: string[] = [];
    const card = { task: "ACM-1", item: "i1", agent: "dev", command: "x", summary: "Run x" };
    const ports = (risky: boolean) => ({
      approvals: () => [card],
      cardVerdict: async () => ({ decision: "left", why: "never", ...(risky ? { risky: true } : {}) }),
      decideCard: async () => void decided.push("left"),
    });
    await choreRun("cards", ports(true), []);
    expect(decided).toHaveLength(1);
    await choreRun("cards", ports(true), ["cards-risky"]);
    expect(decided).toHaveLength(1);
    // The same verdict without the risky mark is the other rule's.
    await choreRun("cards", ports(false), ["cards-risky"]);
    expect(decided).toHaveLength(2);
    await choreRun("cards", ports(false), ["cards-left"]);
    expect(decided).toHaveLength(2);
  });

  it("restarts a stuck run once, then tells the owner, each by its own switch", async () => {
    const calls: string[] = [];
    const ports = {
      stalled: () => [{ id: "ACM-1", lead: "dev", quietSince: "2026-10-04T08:00:00.000Z" }],
      wakeLead: () => void calls.push("wake"),
      pauseForOwner: async () => void calls.push("pause"),
    };
    await choreRun("stuck", ports, []);
    expect(calls).toEqual(["wake"]);
    calls.length = 0;
    await choreRun("stuck", ports, ["stuck-wake"]);
    expect(calls).toEqual(["pause"]);
    calls.length = 0;
    await choreRun("stuck", ports, ["stuck-wake", "stuck-tell"]);
    expect(calls).toEqual([]);
  });

  it("proposes splitting a big task, not when its rule is off", async () => {
    const ports = {
      triageTasks: () => [
        {
          id: "ACM-1",
          title: "Rebuild billing",
          status: "inbox",
          updatedAt: "2026-10-03T00:00:00.000Z",
          checklist: 9,
        },
      ],
    };
    expect(await choreRun("triage", ports, [])).toEqual([
      "Suggests splitting ACM-1 into subtasks: Rebuild billing",
    ]);
    expect(await choreRun("triage", ports, ["triage-split"])).toEqual([]);
  });

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

  it("answers a permission prompt by rule, and leaves it alone when answering is off", async () => {
    const answered: string[] = [];
    const ports = {
      questions: () => [
        {
          task: "ACM-1",
          item: "p1",
          agent: "dev",
          kind: "permission",
          text: "mcp__majhi__list_tasks",
          options: [{ id: "a", label: "Allow once", effect: "allow" }],
        },
      ],
      answeredRecently: () => [],
      laneRest: async () => "resting",
      answer: async (_o: string, _c: unknown, option: string) => void answered.push(option),
    };
    const wanted = { ...RUNS, own: "ask", questions: "decide" } as Authority;
    await choreRun("questions", ports, [], wanted);
    expect(answered).toEqual(["a"]);
    await choreRun("questions", ports, ["q-answer"], wanted);
    expect(answered).toEqual(["a"]);
  });
});

describe("outcome rules of the code health playbooks", () => {
  const spec: FindingSpec = {
    project: "acme-api",
    source: "ci",
    key: "ci:acme-api:main",
    title: "CI is failing on main",
    detail: "",
    evidence: [],
    severity: "medium",
  };
  /** A findings store that counts what is filed and what is made a task. */
  function sensorRun(off: string[]) {
    const calls = { filed: 0, tasks: 0 };
    const findings = {
      report: async () => {
        calls.filed += 1;
        return { result: "created", finding: { id: 7, status: "open" } };
      },
      toTask: async () => {
        calls.tasks += 1;
        return { task: "ACM-9" };
      },
    };
    const playbook = new Catalog().get("eng-ci-health");
    if (playbook === undefined) throw new Error("no CI playbook");
    const ctx = { org: "acme", playbook, findings, rulesOff: new Set(off) } as unknown as RulesContext;
    return { calls, r: reporterOf(ctx) };
  }
  const defaults = (id: string) =>
    (new Catalog().get(id)?.outcomes ?? []).filter((o) => !isRuleOn(o, {})).map((o) => o.id);

  it("files a finding by default and proposes no task, since the task rule starts off", async () => {
    expect(defaults("eng-ci-health")).toEqual(["ci-task"]);
    expect(defaults("upkeep-followups")).toEqual(["fu-task"]);
    const t = sensorRun(defaults("eng-ci-health"));
    expect(await file(t.r, spec)).toBe("created");
    expect(t.calls).toEqual({ filed: 1, tasks: 0 });
  });

  it("files nothing when the finding rule is off and no task is wanted", async () => {
    const t = sensorRun(["ci-finding", "ci-task"]);
    expect(await file(t.r, spec)).toBe("skipped");
    expect(t.calls).toEqual({ filed: 0, tasks: 0 });
  });

  it("proposes a task from the finding when the task rule is on", async () => {
    const t = sensorRun([]);
    await file(t.r, spec);
    expect(t.calls).toEqual({ filed: 1, tasks: 1 });
  });
});

describe("playbooks the owner makes", () => {
  function service(plan?: () => Promise<{ spec: never; plan: string }>) {
    const store = new Store(":memory:");
    const repo = new PlaybookRepo(store.raw);
    const build = () =>
      new PlaybookService({
        repo,
        catalog: new Catalog([]),
        captain: {
          workspace: async () => ({
            org: PRIVATE,
            name: "Private",
            mode: "on",
            authority: RUNS,
            rules: undefined,
            tz: "UTC",
            day: "2026-10-04",
          }),
          repo: new CaptainRepo(store.raw),
          // The scheduler's runner is not used by a made playbook.
          runner: {} as never,
          choreOn: async () => undefined,
        },
        findings: { statsOf: () => ({ total: 0, accepted: 0, dismissed: 0 }) } as never,
        goals: {} as never,
        orgs: async () => [PRIVATE],
        lane: { chat: () => undefined, tell: async () => ({ sent: false as const, why: "test" }) },
        laneTokens: () => 0,
        cancelTurn: async () => undefined,
        mode: () => "on",
        ...(plan === undefined ? {} : { plan }),
      });
    return { build };
  }

  it("is saved off, as a captain playbook, and survives a restart", async () => {
    const t = service();
    const first = t.build();
    const view = await first.create(PRIVATE, {
      name: "Weekly check",
      pack: "business",
      purpose: "Check which clients need an update.",
      cadence: { kind: "weekly", day: 1, at: "09:00" },
      steps: "List clients without an update in 7 days.",
      outputs: ["finding", "draft"],
      tokens: 4000,
    });
    expect(view.enabled).toBe(false);
    expect(view.playbook.custom).toBe(true);
    expect(view.playbook.runner).toEqual({ kind: "captain" });
    expect(view.playbook.enabledByDefault).toBe(false);
    const again = t.build();
    expect(again.catalog.get(view.playbook.id)?.name).toBe("Weekly check");
    // Another workspace sees it off too.
    expect(again.catalog.get(view.playbook.id)?.enabledByDefault).toBe(false);
  });

  it("only a made playbook can be deleted", async () => {
    const svc = service().build();
    expect(() => svc.remove("upkeep-ship")).toThrow();
  });
});
