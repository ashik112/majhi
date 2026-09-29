import type { AgentLive, RoomItem } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { actionCopy, agentDot, agentState, briefBody, firstPendingPermission, modelLabel } from "./model";

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
  it("shows the live model with its effort, else the configured one", () => {
    expect(modelLabel(live({ model: "opus-5.5", effort: "high" }), "sonnet-5.5")).toBe("opus-5.5 · high");
    expect(modelLabel(undefined, "sonnet-5.5")).toBe("sonnet-5.5");
    expect(modelLabel(undefined, undefined)).toBeUndefined();
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
  it("has no button once the work is with the owner or finished", () => {
    for (const status of ["review", "mr", "done"] as const) {
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
