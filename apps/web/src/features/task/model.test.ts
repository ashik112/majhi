import type { AgentLive, RoomItem, TaskSummary } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import {
  actionCopy,
  agentDot,
  agentState,
  briefBody,
  firstPendingPermission,
  linkTargets,
  nowDoingLine,
  relations,
} from "./model";

const live = (over: Partial<AgentLive> = {}): AgentLive => ({
  agent: "a",
  status: "idle",
  queued: 0,
  commands: [],
  ...over,
});

describe("agent state", () => {
  it("names the state and the dot of a live agent", () => {
    expect(agentState(live({ status: "working" }))).toEqual({ label: "Working", tone: "amber" });
    expect(agentState(live({ status: "waiting" })).label).toBe("Waiting for you");
    expect(agentState(live()).label).toBe("Idle");
    expect(agentDot(live({ status: "starting" }))).toBe("amber");
    expect(agentDot(live({ status: "waiting" }))).toBe("violet");
    expect(agentDot(live({ status: "stopped" }))).toBe("neutral");
  });
  it("says not started without live data", () => {
    expect(agentState(undefined).label).toBe("Not started");
    expect(agentDot(undefined)).toBe("neutral");
  });
  it("says what a busy agent is doing, and Idle otherwise", () => {
    expect(nowDoingLine(live({ status: "working", nowDoing: "Editing a.ts" }))).toBe("Editing a.ts");
    expect(nowDoingLine(live({ status: "working" }))).toBe("Idle");
    expect(nowDoingLine(live({ status: "waiting", nowDoing: "Editing a.ts" }))).toBe("Idle");
    expect(nowDoingLine(undefined)).toBe("Idle");
  });
});

describe("actionCopy", () => {
  const code = { kind: "code", pausedReason: undefined } as const;
  it("offers Start before the task runs, and Stop all while it runs", () => {
    expect(actionCopy({ ...code, status: "inbox" }, false).kind).toBe("start");
    expect(actionCopy({ ...code, status: "ready" }, false).text).toMatch(/worktree/);
    expect(actionCopy({ kind: "chat", status: "ready" }, false).text).toMatch(/No worktree/);
    expect(actionCopy({ ...code, status: "running" }, false)).toMatchObject({ kind: "stop", tone: "amber" });
    expect(actionCopy({ ...code, status: "running" }, true)).toMatchObject({ kind: "stop", tone: "violet" });
  });
  it("offers Resume with the reason when paused", () => {
    const copy = actionCopy({ kind: "code", status: "paused", pausedReason: "limit" }, false);
    expect(copy).toMatchObject({ kind: "resume", tone: "coral", warm: true });
    expect(copy.text).toMatch(/usage limit/);
  });
  it("offers Mark done in review, and no button once it has an MR or is done", () => {
    expect(actionCopy({ ...code, status: "review" }, false).kind).toBe("done");
    for (const status of ["mr", "done"] as const) {
      expect(actionCopy({ ...code, status }, false).kind).toBe("none");
    }
  });
});

describe("briefBody", () => {
  it("drops the title line and keeps the rest", () => {
    expect(briefBody("Fix login\n\nIt 500s on expiry.", "Fix login")).toBe("It 500s on expiry.");
  });
  it("is empty when the brief is only the title", () => {
    expect(briefBody("Fix login", "Fix login")).toBe("");
  });
  it("copes with a title cut at 120 characters", () => {
    const long = "x".repeat(150);
    expect(briefBody(`${long}\nmore`, "x".repeat(120))).toBe("more");
  });
});

describe("firstPendingPermission", () => {
  const prompt = (id: string, state: "pending" | "answered"): RoomItem => ({
    id,
    task: "A-1",
    seq: 1,
    at: "x",
    type: "permission",
    agent: "lead",
    title: "npm test",
    options: [],
    state,
  });
  it("finds the first prompt that still waits", () => {
    expect(
      firstPendingPermission([prompt("p1", "answered"), prompt("p2", "pending"), prompt("p3", "pending")]),
    ).toEqual({ itemId: "p2", agent: "lead" });
    expect(firstPendingPermission([])).toBeUndefined();
  });
});

describe("relations", () => {
  const sum = (id: string, over: Partial<TaskSummary> = {}): TaskSummary => ({
    id,
    title: `Title ${id}`,
    kind: "code",
    status: "ready",
    team: [],
    updatedAt: "2026-09-29T10:00:00Z",
    repos: [],
    working: [],
    links: [],
    waitingOn: [],
    ...over,
  });
  const list = [
    sum("A-1", { children: { total: 2, done: 1 } }),
    sum("A-2", {
      links: [
        { type: "parent", task: "A-1" },
        { type: "depends-on", task: "A-3", when: "merged" },
        { type: "depends-on", task: "A-4", when: "ready" },
      ],
      waitingOn: ["A-3"],
    }),
    sum("A-3"),
    sum("A-4", { status: "done" }),
    sum("A-10", { status: "done", links: [{ type: "parent", task: "A-1" }] }),
  ];

  it("joins parent, waiting dependencies and children with the list", () => {
    const child = list[1] as TaskSummary;
    expect(relations(child, list)).toEqual({
      parent: { id: "A-1", title: "Title A-1" },
      depends: [
        { id: "A-3", title: "Title A-3", waiting: true, when: "merged" },
        { id: "A-4", title: "Title A-4", waiting: false, when: "ready" },
      ],
      children: [],
      progress: undefined,
    });
    const parent = relations(list[0] as TaskSummary, list);
    expect(parent.children.map((c) => c.id)).toEqual(["A-2", "A-10"]);
    expect(parent.progress).toEqual({ total: 2, done: 1 });
  });

  it("offers open tasks not yet linked that way", () => {
    const child = list[1] as TaskSummary;
    expect(linkTargets(child, list, "depends-on").map((t) => t.id)).toEqual(["A-1"]);
    expect(linkTargets(child, list, "parent").map((t) => t.id)).toEqual(["A-3"]);
  });
});
