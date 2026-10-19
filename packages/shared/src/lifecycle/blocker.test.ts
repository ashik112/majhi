import { describe, expect, it } from "vitest";
import {
  BLOCKER_ORDER,
  type Blocker,
  type BlockerTask,
  type BlockerWorld,
  blockerOf,
  isUntriaged,
} from "./blocker.ts";

const room = (inUse: number, limit: number) => ({ inUse, limit, free: Math.max(0, limit - inUse) });

/** A world with room everywhere and nothing wrong. */
function world(over: Partial<BlockerWorld> = {}): BlockerWorld {
  return {
    autopilot: "on",
    machine: undefined,
    slots: { agents: room(1, 5), accounts: new Map([["claude-acme", room(1, 3)]]) },
    atOnce: new Map([["acme", { running: [], max: 2 }]]),
    accountTrouble: new Map(),
    budgets: [],
    ...over,
  };
}

/** A ready task of Acme with nothing in its way. */
function task(over: Partial<BlockerTask> = {}): BlockerTask {
  return {
    id: "ACM-1",
    status: "ready",
    kind: "code",
    org: "acme",
    priority: "normal",
    due: undefined,
    repos: 1,
    waitingOn: [],
    accounts: ["claude-acme"],
    ...over,
  };
}

describe("blockerOf, one test per reason", () => {
  it("tasks-at-once: another workspace's limit does not hold it", () => {
    const other = world({ atOnce: new Map([["globex", { running: ["GLX-1"], max: 1 }]]) });
    expect(blockerOf(task(), other)).toEqual({ gate: "nobody", autopilot: "on" });
  });

  it("budget: a hold covers the workspace, the account, or everything", () => {
    const org: Blocker = { gate: "budget", scope: "org", scopeId: "acme", period: "day" };
    expect(blockerOf(task(), world({ budgets: [org] }))).toEqual(org);
    expect(blockerOf(task({ org: "globex" }), world({ budgets: [org] }))).toEqual({
      gate: "nobody",
      autopilot: "on",
    });
    const reserve: Blocker = { gate: "budget", scope: "reserve", scopeId: "claude-acme", period: "day" };
    expect(blockerOf(task(), world({ budgets: [reserve] }))).toEqual(reserve);
    const ceiling: Blocker = { gate: "budget", scope: "all", period: "month" };
    expect(blockerOf(task({ org: "globex", accounts: [] }), world({ budgets: [ceiling] }))).toEqual(ceiling);
  });
});

describe("blockerOf, when several apply", () => {
  /** Every gate failing at once, so each assertion removes the one above it. */
  const everything = (): BlockerWorld =>
    world({
      machine: "load",
      slots: { agents: room(5, 5), accounts: new Map([["claude-acme", room(3, 3)]]) },
      atOnce: new Map([["acme", { running: ["ACM-2"], max: 1 }]]),
      accountTrouble: new Map([["claude-acme", "limit"]]),
      budgets: [{ gate: "budget", scope: "all", period: "day" }],
    });

  it("returns the gates in the documented order", () => {
    const seen: string[] = [];
    let w = everything();
    let t = task({ status: "inbox", priority: undefined, waitingOn: ["ACM-9"] });
    const next = () => blockerOf(t, w)?.gate;
    seen.push(next() as string);
    t = { ...t, priority: "high" };
    seen.push(next() as string);
    t = { ...t, waitingOn: [] };
    seen.push(next() as string);
    w = { ...w, accountTrouble: new Map() };
    seen.push(next() as string);
    w = { ...w, machine: undefined };
    seen.push(next() as string);
    w = { ...w, slots: { agents: room(1, 5), accounts: new Map() } };
    seen.push(next() as string);
    w = { ...w, atOnce: new Map() };
    seen.push(next() as string);
    w = { ...w, budgets: [] };
    seen.push(next() as string);
    expect(seen).toEqual([
      "untriaged",
      "dependency",
      "account",
      "machine",
      "slots",
      "tasks-at-once",
      "budget",
      "nobody",
    ]);
    expect(seen).toEqual([...BLOCKER_ORDER]);
  });

  it("isUntriaged needs both priority and due absent", () => {
    expect(isUntriaged({ status: "inbox", priority: undefined, due: "2026-10-10" })).toBe(false);
    expect(isUntriaged({ status: "ready", priority: undefined, due: undefined })).toBe(false);
  });
});
