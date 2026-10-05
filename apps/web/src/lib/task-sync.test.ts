import type { OwnerDecision, TaskSummary } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { patchDecisions, patchTaskList } from "./task-sync";

const row = (id: string, updatedAt: string, status: TaskSummary["status"] = "running"): TaskSummary => ({
  id,
  title: `Task ${id}`,
  kind: "code",
  status,
  team: [],
  updatedAt,
  repos: [],
  working: [],
  links: [],
  waitingOn: [],
});

describe("patching the task list from an event", () => {
  const a = row("ACM-1", "2026-10-05T10:00:00.000Z");
  const b = row("ACM-2", "2026-10-05T09:00:00.000Z");
  const c = row("ACM-3", "2026-10-05T08:00:00.000Z");

  it("replaces a named row, keeps the others as the same objects, and keeps newest first", () => {
    const changed = row("ACM-3", "2026-10-05T11:00:00.000Z", "review");
    const next = patchTaskList([a, b, c], ["ACM-3"], [changed]);
    expect(next.map((t) => t.id)).toEqual(["ACM-3", "ACM-1", "ACM-2"]);
    expect(next[0]).toBe(changed);
    expect(next[1]).toBe(a);
    expect(next[2]).toBe(b);
  });

  it("adds a task the list did not have and drops a named task the server no longer lists", () => {
    const fresh = row("ACM-4", "2026-10-05T12:00:00.000Z");
    expect(patchTaskList([a, b], ["ACM-4"], [fresh]).map((t) => t.id)).toEqual(["ACM-4", "ACM-1", "ACM-2"]);
    expect(patchTaskList([a, b], ["ACM-2"], []).map((t) => t.id)).toEqual(["ACM-1"]);
  });
});

describe("patching the decisions list from an event", () => {
  const d = (id: string, kind: OwnerDecision["kind"], at: string, task?: string): OwnerDecision => ({
    id,
    kind,
    title: id,
    options: [],
    at,
    link: { kind: "captain" },
    ...(task === undefined ? {} : { task }),
  });

  it("swaps the named tasks' decisions and keeps the server's order, ship first", () => {
    const old = d("room:ACM-1:i1", "question", "2026-10-05T08:00:00.000Z", "ACM-1");
    const other = d("room:ACM-2:i2", "question", "2026-10-05T07:00:00.000Z", "ACM-2");
    const signIn = d("signin:x", "sign-in", "2026-10-05T06:00:00.000Z");
    const ship = d("room:ACM-1:rv", "ship", "2026-10-05T09:00:00.000Z", "ACM-1");
    const next = patchDecisions([signIn, other, old], new Set(["ACM-1"]), [ship]);
    expect(next.map((x) => x.id)).toEqual(["room:ACM-1:rv", "signin:x", "room:ACM-2:i2"]);
    expect(next[2]).toBe(other);
  });
});
