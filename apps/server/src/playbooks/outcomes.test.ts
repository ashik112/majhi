import { type Authority, PRIVATE } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
import { createChores } from "../captain/chores.ts";
import type { CaptainPorts } from "../captain/ports.ts";
import { CaptainRepo } from "../captain/repo.ts";
import { ChoreRunner, type Workspace } from "../captain/runner.ts";
import { Store } from "../store/index.ts";
import { Catalog } from "./catalog.ts";
import { PlaybookRepo } from "./repo.ts";
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
