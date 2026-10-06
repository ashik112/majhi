import { boardCounts, type OwnerDecision, type TaskStatus, type TaskSummary } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { buildHome, type HomeInput, needsAgrees, type SectionId, sectionOf } from "./home-model.ts";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const TODAY = "2026-10-05T09:00:00.000Z";

function task(id: string, status: TaskStatus, over: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id,
    title: `Task ${id}`,
    kind: "code",
    status,
    team: ["lead"],
    mode: "lead",
    updatedAt: TODAY,
    repos: [],
    working: [],
    links: [],
    waitingOn: [],
    trail: [],
    ...over,
  };
}

function decision(id: string, taskId: string | undefined, org?: string): OwnerDecision {
  return {
    id,
    kind: "question",
    ...(org === undefined ? {} : { org }),
    ...(taskId === undefined ? {} : { task: taskId }),
    title: "@lead asks: Queue or cron?",
    options: [],
    at: TODAY,
    link: taskId === undefined ? { kind: "captain" } : { kind: "task", id: taskId },
  };
}

/** One task in every state, in two workspaces, with decisions on some. */
function world(): { tasks: TaskSummary[]; decisions: OwnerDecision[] } {
  const tasks = [
    task("ACM-1", "running", { org: "acme", working: ["lead"] }),
    task("ACM-2", "running", { org: "acme", working: ["lead"] }),
    task("ACM-3", "running", { org: "acme" }),
    task("ACM-4", "paused", { org: "acme" }),
    task("ACM-5", "review", { org: "acme" }),
    task("ACM-6", "mr", { org: "acme" }),
    task("ACM-7", "ready", { org: "acme" }),
    task("ACM-8", "inbox", { org: "acme" }),
    task("ACM-9", "inbox", { org: "acme", priority: "high" }),
    task("ACM-10", "done", { org: "acme" }),
    task("ACM-11", "done", { org: "acme", updatedAt: "2026-10-01T09:00:00.000Z" }),
    task("GLX-1", "running", { org: "globex", working: ["lead"] }),
    task("GLX-2", "review", { org: "globex" }),
    task("GLX-3", "mr", { org: "globex" }),
    task("GLX-4", "ready", { org: "globex", waitingOn: ["GLX-1"] }),
    task("GLX-5", "inbox", { org: "globex" }),
    task("GLX-6", "paused", { org: "globex", children: { total: 3, done: 1 } }),
    task("PRV-1", "ready"),
    task("PRV-2", "running", { chat: true }),
    task("PRV-3", "running", { chat: true, working: ["lead"] }),
  ];
  const decisions = [
    decision("room:ACM-2:q1", "ACM-2", "acme"),
    decision("room:GLX-2:ship", "GLX-2", "globex"),
    decision("room:PRV-3:q", "PRV-3"),
    decision("signin:claude-acme", undefined),
  ];
  return { tasks, decisions };
}

function input(over: Partial<HomeInput> = {}): HomeInput {
  const { tasks, decisions } = world();
  const counts = boardCounts(
    decisions,
    tasks.filter((t) => t.working.length > 0).map((t) => ({ task: t.id, org: t.org })),
  );
  return {
    tasks,
    decisions,
    working: new Set(counts.workingTasks),
    blockers: new Map(),
    mrs: new Map(),
    mrExtra: new Map(),
    doing: new Map(),
    checks: new Map(),
    background: [],
    captain: [],
    undoOf: new Map(),
    org: undefined,
    query: "",
    now: NOW,
    ...over,
  };
}

const ids = (list: { task: TaskSummary }[]) => list.map((i) => i.task.id);

describe("section of a task", () => {
  it("puts each task in exactly one section", () => {
    const { sections } = buildHome(input());
    const seen = new Map<string, SectionId[]>();
    const add = (id: string | undefined, section: SectionId) => {
      if (id !== undefined) seen.set(id, [...(seen.get(id) ?? []), section]);
    };
    for (const n of sections.needs) add(n.decision.task, "needs");
    for (const h of sections.held) add(h.task.id, "needs");
    for (const r of sections.running) add(r.task.id, "running");
    for (const w of sections.waiting) add(w.task.id, "waiting");
    for (const s of sections.shipping) add(s.task.id, "shipping");
    for (const q of sections.next) add(q.task.id, "next");
    for (const q of sections.triage) add(q.task.id, "triage");
    for (const d of sections.done) add(d.task.id, "done");
    for (const [id, where] of seen) expect(where, id).toHaveLength(1);
    expect(Object.fromEntries(seen)).toEqual({
      "ACM-1": ["running"],
      "ACM-2": ["needs"],
      "ACM-3": ["next"],
      // Paused, and nothing says majhi lifts it: the owner does.
      "ACM-4": ["needs"],
      "ACM-5": ["next"],
      "ACM-6": ["shipping"],
      "ACM-7": ["next"],
      "ACM-8": ["triage"],
      "ACM-9": ["next"],
      "ACM-10": ["done"],
      "GLX-1": ["running"],
      "GLX-2": ["needs"],
      "GLX-3": ["shipping"],
      // It waits on another task, which is not the owner.
      "GLX-4": ["waiting"],
      "GLX-5": ["triage"],
      // A parent with open subtasks and no agent waits for them.
      "GLX-6": ["waiting"],
      "PRV-1": ["next"],
      "PRV-3": ["needs"],
    });
  });

  it("draws no quiet chat and no task finished before today", () => {
    const { sections } = buildHome(input());
    const all = [...ids(sections.running), ...ids(sections.next), ...ids(sections.done)];
    expect(all).not.toContain("PRV-2");
    expect(all).not.toContain("ACM-11");
  });

  it("a task a decision waits on is Needs you, whatever its status", () => {
    const asking = new Set(["ACM-6"]);
    expect(sectionOf(task("ACM-6", "mr"), { asking, working: new Set() })).toBe("needs");
    expect(sectionOf(task("ACM-6", "mr"), { asking: new Set(), working: new Set() })).toBe("shipping");
  });

  it("a paused task goes by who ends its hold", () => {
    const ctx = { asking: new Set<string>(), working: new Set<string>() };
    const hold = (lifter: "owner" | "system") => ({ lifter, label: "usage limit", sentence: "It resumes." });
    expect(sectionOf(task("ACM-4", "paused", { hold: hold("system") }), ctx)).toBe("waiting");
    expect(sectionOf(task("ACM-4", "paused", { hold: hold("owner") }), ctx)).toBe("needs");
  });

  it("a parent is running while a subtask runs, and waiting while none does", () => {
    const ctx = { asking: new Set<string>(), working: new Set<string>() };
    const parent = (tone: "working" | "idle") =>
      task("ACM-20", "running", {
        children: { total: 2, done: 0 },
        trail: [{ kind: "children", tone, total: 2, done: 0 }],
      });
    expect(sectionOf(parent("working"), ctx)).toBe("running");
    expect(sectionOf(parent("idle"), ctx)).toBe("waiting");
  });

  it("a running task with no agent is queued, one with an agent is running", () => {
    const ctx = { asking: new Set<string>(), working: new Set(["ACM-1"]) };
    expect(sectionOf(task("ACM-1", "running"), ctx)).toBe("running");
    expect(sectionOf(task("ACM-3", "running"), ctx)).toBe("next");
  });
});

describe("Needs you equals the server's decision counts", () => {
  it("for all workspaces, and for each one", () => {
    const data = input();
    const counts = boardCounts(data.decisions, [
      { task: "ACM-1", org: "acme" },
      { task: "GLX-1", org: "globex" },
    ]);
    const all = buildHome(data).sections;
    expect(all.needs).toHaveLength(counts.needsYou);
    expect(needsAgrees(all, counts, undefined)).toBe(true);
    for (const org of ["acme", "globex", "private"]) {
      const own = buildHome({ ...data, org }).sections;
      expect(own.needs.length, org).toBe(counts.orgs[org]?.needsYou ?? 0);
      expect(needsAgrees(own, counts, org), org).toBe(true);
    }
  });

  it("a decision with no task (a sign-in) is a row too", () => {
    const { sections } = buildHome(input());
    expect(sections.needs.map((n) => n.decision.id)).toContain("signin:claude-acme");
  });
});
