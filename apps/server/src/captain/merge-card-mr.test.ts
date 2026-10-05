import type { Authority, ShipFix } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { RUNS } from "./authority-fixtures.ts";
import { createChores } from "./chores.ts";
import type { ApprovalCard, CaptainPorts } from "./ports.ts";
import { CaptainRepo } from "./repo.ts";
import { ChoreRunner, type Workspace } from "./runner.ts";

/** A lead's merge card where Merge is the owner's: Push decides whether it becomes a merge request. */

const NOW = () => new Date("2026-10-04T10:00:00.000Z");

const CARD: ApprovalCard = {
  task: "ACM-1",
  item: "a1",
  agent: "lead",
  command: "tasks.merge",
  input: { id: "ACM-1", done: true },
  summary: "@lead wants to Merge ACM-1 into its base",
};

type MrReady = { ok: true; host: string } | { ok: false; why: string; fix?: ShipFix };

function setup(authority: Authority, mr: MrReady = { ok: true, host: "GitHub" }) {
  const repo = new CaptainRepo(new Store(":memory:").raw);
  const calls = {
    merged: 0,
    opened: 0,
    settled: [] as string[],
    left: [] as { why: string; fix?: ShipFix | undefined }[],
    verdicts: 0,
  };
  let ready = mr;
  const ports = {
    typing: () => false,
    approvals: () => [CARD],
    questions: () => [],
    shipCheck: async () => ({
      ready: true,
      evidence: "checks pass",
      targets: [{ project: "majhi", into: "main", base: "main" }],
    }),
    ship: async () => {
      calls.merged += 1;
      return { text: "Shipped" };
    },
    mrReady: async () => ready,
    openMrs: async () => {
      calls.opened += 1;
      return { urls: ["https://github.example/acme/api/pull/9"], host: "GitHub" };
    },
    settleMergeCard: async (_org: string, _card: ApprovalCard, line: string) => {
      calls.settled.push(line);
    },
    cardVerdict: async () => {
      calls.verdicts += 1;
      return { decision: "left" as const, why: "In Acme you decide when work is merged" };
    },
    decideCard: async (_org: string, _card: ApprovalCard, verdict: { why: string; fix?: ShipFix }) => {
      calls.left.push({ why: verdict.why, fix: verdict.fix });
      return { ok: true };
    },
  } as unknown as CaptainPorts;
  const ws = (): Workspace => ({
    org: "acme",
    name: "Acme",
    mode: "on",
    authority,
    rules: undefined,
    tz: "UTC",
    day: "2026-10-04",
    rulesOff: new Set(),
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
    const r = await runner.startNow("acme", "cards");
    if (r.ran) await r.done;
  };
  return {
    run,
    calls,
    fixed: (next: MrReady) => {
      ready = next;
    },
  };
}

describe("a lead's merge card when Merge is the owner's", () => {
  it("opens the merge request, settles the card with the link and never merges", async () => {
    const t = setup({ ...RUNS, merge: "ask", push: "decide" });
    await t.run();
    expect(t.calls).toMatchObject({ merged: 0, opened: 1, verdicts: 0 });
    expect(t.calls.settled).toEqual([
      "Opened MR https://github.example/acme/api/pull/9 on GitHub instead: the owner merges",
    ]);
  });

  it("leaves the card for the owner, naming the host and the fix, when majhi cannot push", async () => {
    const fix: ShipFix = { page: "orgs", org: "acme" };
    const t = setup(
      { ...RUNS, merge: "ask", push: "decide" },
      { ok: false, why: "No GitHub token: add one in Orgs > Acme.", fix },
    );
    await t.run();
    expect(t.calls).toMatchObject({ merged: 0, opened: 0 });
    expect(t.calls.left).toEqual([
      {
        why: "The captain could not open the merge request: No GitHub token: add one in Orgs > Acme.",
        fix,
      },
    ]);
  });

  it("opens it once the account is connected", async () => {
    const t = setup(
      { ...RUNS, merge: "ask", push: "decide" },
      { ok: false, why: "No GitHub token: add one in Orgs > Acme.", fix: { page: "orgs", org: "acme" } },
    );
    await t.run();
    t.fixed({ ok: true, host: "GitHub" });
    await t.run();
    expect(t.calls.opened).toBe(1);
    expect(t.calls.settled).toHaveLength(1);
  });

  it("leaves the card for the owner as before when Push is also theirs", async () => {
    const t = setup({ ...RUNS, merge: "ask", push: "ask" });
    await t.run();
    expect(t.calls).toMatchObject({ merged: 0, opened: 0, verdicts: 1 });
    expect(t.calls.settled).toEqual([]);
  });
});
