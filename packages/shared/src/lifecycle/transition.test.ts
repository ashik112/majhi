import { describe, expect, it } from "vitest";
import { type ClearReading, type Hold, type HoldCause, type HoldOf, liftersOf, sentenceOf } from "./hold.ts";
import {
  type Effect,
  isRefusal,
  type LifecycleEvent,
  type LifecycleStatus,
  type Refusal,
  type TaskState,
  type Transition,
  transition,
} from "./transition.ts";

const AT = "2026-10-05T10:00:00.000Z";

const task = (o: Partial<TaskState> = {}): TaskState => ({
  id: "ACME-1",
  status: "inbox",
  hold: undefined,
  startWhenReady: false,
  hasLiveRun: false,
  unmetDeps: [],
  exemptUntilRunEnds: false,
  ...o,
});

const SAMPLES: { [C in HoldCause]: HoldOf<C> } = {
  "owner-stop": { cause: "owner-stop", at: AT },
  "captain-stop": { cause: "captain-stop", at: AT, why: "off track" },
  "autonomous-off": { cause: "autonomous-off", at: AT, mode: "now" },
  "autonomous-stop": { cause: "autonomous-stop", at: AT, why: "it failed twice" },
  "budget-limit": { cause: "budget-limit", at: AT, scope: "org", scopeId: "acme", period: "day" },
  "account-limit": { cause: "account-limit", at: AT, account: "claude-acme" },
  offline: { cause: "offline", at: AT },
  "signed-out": { cause: "signed-out", at: AT, account: "claude-acme" },
  error: { cause: "error", at: AT, phase: "turn", error: "boom" },
  "loop-guard": { cause: "loop-guard", at: AT, why: "no progress" },
  idle: { cause: "idle", at: AT, why: "Nobody is left." },
  preempted: { cause: "preempted", at: AT },
  "agents-down": { cause: "agents-down", at: AT, down: [{ account: "claude-acme", state: "signed-out" }] },
  "dependency-closed": { cause: "dependency-closed", at: AT, on: ["ACME-2"] },
  "dependency-removed": { cause: "dependency-removed", at: AT, on: ["ACME-2"] },
};
const CAUSES = Object.keys(SAMPLES) as HoldCause[];
const hold = (c: HoldCause): Hold => SAMPLES[c];

const ALL: LifecycleStatus[] = ["inbox", "ready", "running", "review", "mr", "done"];

const ok = (r: Transition | Refusal): Transition => {
  if (isRefusal(r)) throw new Error(`refused: ${r.code} ${r.text}`);
  return r;
};
const refused = (r: Transition | Refusal): Refusal => {
  if (!isRefusal(r)) throw new Error(`expected a refusal, got ${JSON.stringify(r.next)}`);
  return r;
};
const label = (e: Effect): string => {
  switch (e.kind) {
    case "card":
      return `card:${e.card}`;
    case "containers":
      return `containers:${e.op}`;
    case "startWhenReady":
      return `startWhenReady:${e.set}`;
    default:
      return e.kind;
  }
};
const effectsOf = (t: Transition): string[] => t.effects.map(label);

const STOP = [
  "runs.stop",
  "containers:stop",
  "processes.stop",
  "terminals.stop",
  "dropPendingShip",
  "card:paused",
  "publishTask",
];
const PAUSED = ["parkServices", "card:paused", "publishTask", "statusChanged"];
const SETTLE_RESUME = ["containers:runAgain", "ensureWorktrees", "runs.start", "card:settle", "publishTask"];

interface Row {
  name: string;
  from: TaskState | undefined;
  event: LifecycleEvent;
  status: LifecycleStatus;
  hold: HoldCause | undefined;
  effects: string[];
  check?: (next: TaskState) => void;
}

const ROWS: Row[] = [
  {
    name: "create inbox",
    from: undefined,
    event: { type: "create", id: "ACME-1", status: "inbox" },
    status: "inbox",
    hold: undefined,
    effects: ["publishTask"],
  },
  {
    name: "create ready, start when ready",
    from: undefined,
    event: { type: "create", id: "ACME-1", status: "ready", startWhenReady: true },
    status: "ready",
    hold: undefined,
    effects: ["startWhenReady:true", "publishTask"],
    check: (n) => expect(n.startWhenReady).toBe(true),
  },
  {
    name: "create split child",
    from: undefined,
    event: { type: "create", id: "ACME-3", status: "ready" },
    status: "ready",
    hold: undefined,
    effects: ["publishTask"],
  },
  {
    name: "wishStart from inbox",
    from: task({ status: "inbox" }),
    event: { type: "wishStart" },
    status: "ready",
    hold: undefined,
    effects: ["startWhenReady:true", "publishTask"],
    check: (n) => expect(n.startWhenReady).toBe(true),
  },
  {
    name: "wishStart from ready",
    from: task({ status: "ready" }),
    event: { type: "wishStart" },
    status: "ready",
    hold: undefined,
    effects: ["startWhenReady:true", "publishTask"],
  },
  {
    name: "start from inbox",
    from: task({ status: "inbox", startWhenReady: true }),
    event: { type: "start", by: "owner" },
    status: "running",
    hold: undefined,
    effects: ["runs.start", "ensureWorktrees", "publishTask", "statusChanged"],
    check: (n) => expect(n.startWhenReady).toBe(false),
  },
  {
    name: "start from ready",
    from: task({ status: "ready" }),
    event: { type: "start", by: "captain" },
    status: "running",
    hold: undefined,
    effects: ["runs.start", "ensureWorktrees", "publishTask", "statusChanged"],
  },
  {
    name: "start already running is a no-op",
    from: task({ status: "running", hasLiveRun: true }),
    event: { type: "start", by: "majhi" },
    status: "running",
    hold: undefined,
    effects: [],
  },
  {
    name: "sendBack",
    from: task({ status: "review" }),
    event: { type: "sendBack", by: "owner" },
    status: "running",
    hold: undefined,
    effects: ["runs.start", "publishTask"],
  },
  {
    name: "ownerStop running",
    from: task({ status: "running", hasLiveRun: true }),
    event: { type: "ownerStop", at: AT },
    status: "running",
    hold: "owner-stop",
    effects: STOP,
  },
  {
    name: "ownerStop review",
    from: task({ status: "review" }),
    event: { type: "ownerStop", at: AT },
    status: "review",
    hold: "owner-stop",
    effects: STOP,
  },
  {
    name: "captainStop running",
    from: task({ status: "running" }),
    event: { type: "captainStop", at: AT, why: "off track" },
    status: "running",
    hold: "captain-stop",
    effects: STOP,
  },
  {
    name: "captainStop review",
    from: task({ status: "review" }),
    event: { type: "captainStop", at: AT },
    status: "review",
    hold: "captain-stop",
    effects: STOP,
  },
  {
    name: "autonomousOff now running",
    from: task({ status: "running" }),
    event: { type: "autonomousOff", at: AT, mode: "now" },
    status: "running",
    hold: "autonomous-off",
    effects: STOP,
  },
  {
    name: "autonomousOff now review",
    from: task({ status: "review" }),
    event: { type: "autonomousOff", at: AT, mode: "now" },
    status: "review",
    hold: "autonomous-off",
    effects: STOP,
  },
  {
    name: "autonomousOff step waits for the step",
    from: task({ status: "running", hasLiveRun: true }),
    event: { type: "autonomousOff", at: AT, mode: "step" },
    status: "running",
    hold: "autonomous-off",
    effects: ["publishTask"],
    check: (n) => expect(n.hold).toMatchObject({ mode: "step" }),
  },
  {
    name: "autonomousOn with resume restarts a run",
    from: task({ status: "running", hold: hold("autonomous-off") }),
    event: { type: "autonomousOn", at: AT, resume: true },
    status: "running",
    hold: undefined,
    effects: ["runs.start", "containers:runAgain", "card:settle", "publishTask"],
  },
  {
    name: "autonomousOn with resume and a live run starts none",
    from: task({ status: "running", hasLiveRun: true, hold: hold("autonomous-off") }),
    event: { type: "autonomousOn", at: AT, resume: true },
    status: "running",
    hold: undefined,
    effects: ["containers:runAgain", "card:settle", "publishTask"],
  },
  {
    name: "autonomousOn leave paused hands the pause to the owner",
    from: task({ status: "running", hold: hold("autonomous-off") }),
    event: { type: "autonomousOn", at: AT, resume: false },
    status: "running",
    hold: "owner-stop",
    effects: ["publishTask"],
  },
  {
    name: "autonomousOn clears a step hold even without resume",
    from: task({
      status: "running",
      hasLiveRun: true,
      hold: { cause: "autonomous-off", at: AT, mode: "step" },
    }),
    event: { type: "autonomousOn", at: AT, resume: false },
    status: "running",
    hold: undefined,
    effects: ["containers:runAgain", "card:settle", "publishTask"],
  },
  {
    name: "autonomousOn with no Autonomous hold changes nothing",
    from: task({ status: "running", hold: hold("owner-stop") }),
    event: { type: "autonomousOn", at: AT, resume: true },
    status: "running",
    hold: "owner-stop",
    effects: [],
  },
  {
    name: "runPaused offline",
    from: task({ status: "running", hasLiveRun: true }),
    event: { type: "runPaused", hold: hold("offline") },
    status: "running",
    hold: "offline",
    effects: PAUSED,
  },
  {
    name: "runPaused in review",
    from: task({ status: "review" }),
    event: { type: "runPaused", hold: hold("signed-out") },
    status: "review",
    hold: "signed-out",
    effects: PAUSED,
  },
  {
    name: "runPaused error drops the pending ship",
    from: task({ status: "running" }),
    event: { type: "runPaused", hold: hold("error") },
    status: "running",
    hold: "error",
    effects: ["dropPendingShip", ...PAUSED],
  },
  {
    name: "runPaused keeps an owner-only hold",
    from: task({ status: "running", hold: hold("owner-stop") }),
    event: { type: "runPaused", hold: hold("offline") },
    status: "running",
    hold: "owner-stop",
    effects: [],
  },
  {
    name: "runPaused replaces a hold more can lift",
    from: task({ status: "running", hold: hold("offline") }),
    event: { type: "runPaused", hold: hold("loop-guard") },
    status: "running",
    hold: "loop-guard",
    effects: PAUSED,
  },
  {
    name: "runResumed clears a majhi-liftable hold",
    from: task({ status: "running", hold: hold("offline") }),
    event: { type: "runResumed" },
    status: "running",
    hold: undefined,
    effects: SETTLE_RESUME,
  },
  {
    name: "runResumed with a live run starts none",
    from: task({ status: "review", hasLiveRun: true, hold: hold("account-limit") }),
    event: { type: "runResumed" },
    status: "review",
    hold: undefined,
    effects: ["containers:runAgain", "ensureWorktrees", "card:settle", "publishTask"],
  },
  {
    name: "runResumed with no hold is a no-op",
    from: task({ status: "running" }),
    event: { type: "runResumed" },
    status: "running",
    hold: undefined,
    effects: [],
  },
  {
    name: "holdPlaced on running",
    from: task({ status: "running" }),
    event: { type: "holdPlaced", hold: hold("budget-limit") },
    status: "running",
    hold: "budget-limit",
    effects: PAUSED,
  },
  {
    name: "holdPlaced on review",
    from: task({ status: "review" }),
    event: { type: "holdPlaced", hold: hold("budget-limit") },
    status: "review",
    hold: "budget-limit",
    effects: PAUSED,
  },
  {
    name: "holdPlaced on inbox",
    from: task({ status: "inbox" }),
    event: { type: "holdPlaced", hold: hold("budget-limit") },
    status: "inbox",
    hold: "budget-limit",
    effects: PAUSED,
  },
  {
    name: "holdPlaced on ready",
    from: task({ status: "ready" }),
    event: { type: "holdPlaced", hold: hold("budget-limit") },
    status: "ready",
    hold: "budget-limit",
    effects: PAUSED,
  },
  {
    name: "holdCleared by owner restarts a run",
    from: task({ status: "running", hold: hold("owner-stop") }),
    event: { type: "holdCleared", by: "owner" },
    status: "running",
    hold: undefined,
    effects: ["runs.start", "card:settle", "publishTask"],
  },
  {
    name: "holdCleared by the captain",
    from: task({ status: "review", hold: hold("captain-stop") }),
    event: { type: "holdCleared", by: "captain" },
    status: "review",
    hold: undefined,
    effects: ["runs.start", "card:settle", "publishTask"],
  },
  {
    name: "holdCleared on a ready task starts nothing",
    from: task({ status: "ready", hold: hold("dependency-closed") }),
    event: { type: "holdCleared", by: "owner" },
    status: "ready",
    hold: undefined,
    effects: ["card:settle", "publishTask"],
  },
  {
    name: "holdCleared by the owner on a budget hold exempts the run",
    from: task({ status: "running", hold: hold("budget-limit") }),
    event: { type: "holdCleared", by: "owner" },
    status: "running",
    hold: undefined,
    effects: ["runs.start", "budgets.exempt", "card:settle", "publishTask"],
    check: (n) => expect(n.exemptUntilRunEnds).toBe(true),
  },
  {
    name: "holdCleared by majhi when its condition holds",
    from: task({ status: "running", hold: hold("offline") }),
    event: {
      type: "holdCleared",
      by: "majhi",
      reading: {
        now: AT,
        online: true,
        accounts: {},
        budgetHasRoom: false,
        autonomous: "on",
        runAtStep: false,
      },
    },
    status: "running",
    hold: undefined,
    effects: ["runs.start", "card:settle", "publishTask"],
  },
  {
    name: "agentsIdle",
    from: task({ status: "running" }),
    event: { type: "agentsIdle" },
    status: "review",
    hold: undefined,
    effects: ["card:review", "publishTask"],
  },
  {
    name: "processEnded",
    from: task({ status: "review" }),
    event: { type: "processEnded" },
    status: "running",
    hold: undefined,
    effects: ["publishTask"],
  },
  {
    name: "changeAndReview",
    from: task({ status: "inbox" }),
    event: { type: "changeAndReview" },
    status: "review",
    hold: undefined,
    effects: ["card:review"],
  },
  ...(["inbox", "ready", "running", "review"] as const).map(
    (status): Row => ({
      name: `mrOpened from ${status}`,
      from: task({ status }),
      event: { type: "mrOpened" },
      status: "mr",
      hold: undefined,
      effects: ["card:mr"],
    }),
  ),
  {
    name: "mrClosedUnmerged",
    from: task({ status: "mr" }),
    event: { type: "mrClosedUnmerged" },
    status: "review",
    hold: undefined,
    effects: ["card:review"],
  },
  ...ALL.filter((s) => s !== "done").map(
    (status): Row => ({
      name: `close from ${status} clears the hold`,
      from: task({
        status,
        hold: status === "running" ? hold("offline") : undefined,
        startWhenReady: status === "ready",
        exemptUntilRunEnds: status === "running",
      }),
      event: { type: "close" },
      status: "done",
      hold: undefined,
      effects: ["runs.stop", "containers:stop", "processes.stop", "card:done"],
      check: (n) => {
        expect(n.startWhenReady).toBe(false);
        expect(n.exemptUntilRunEnds).toBe(false);
      },
    }),
  ),
  {
    name: "reopen to review",
    from: task({ status: "done" }),
    event: { type: "reopen", to: "review" },
    status: "review",
    hold: undefined,
    effects: ["card:review"],
  },
  {
    name: "reopen to inbox",
    from: task({ status: "done" }),
    event: { type: "reopen", to: "inbox" },
    status: "inbox",
    hold: undefined,
    effects: ["card:review"],
  },
  {
    name: "dependency closed unmerged on inbox",
    from: task({ status: "inbox", startWhenReady: true, unmetDeps: ["ACME-2"] }),
    event: { type: "dependencyChanged", change: "closed-unmerged", on: ["ACME-2"], at: AT },
    status: "inbox",
    hold: "dependency-closed",
    effects: ["card:paused", "publishTask"],
    check: (n) => {
      expect(n.startWhenReady).toBe(false);
      expect(n.unmetDeps).toEqual(["ACME-2"]);
    },
  },
  {
    name: "dependency closed unmerged on ready",
    from: task({ status: "ready" }),
    event: { type: "dependencyChanged", change: "closed-unmerged", on: ["ACME-2"], at: AT },
    status: "ready",
    hold: "dependency-closed",
    effects: ["card:paused", "publishTask"],
  },
  {
    name: "dependency removed on ready",
    from: task({ status: "ready", unmetDeps: ["ACME-2", "ACME-4"] }),
    event: { type: "dependencyChanged", change: "removed", on: ["ACME-2"], at: AT },
    status: "ready",
    hold: "dependency-removed",
    effects: ["card:paused", "publishTask"],
    check: (n) => expect(n.unmetDeps).toEqual(["ACME-4"]),
  },
  {
    name: "dependency removed on a running task that already has a dependency hold",
    from: task({ status: "running", hold: hold("dependency-closed") }),
    event: { type: "dependencyChanged", change: "removed", on: ["ACME-2"], at: AT },
    status: "running",
    hold: "dependency-removed",
    effects: ["card:paused", "publishTask"],
  },
  {
    name: "dependency met drops it from the unmet list",
    from: task({ status: "ready", unmetDeps: ["ACME-2", "ACME-4"] }),
    event: { type: "dependencyChanged", change: "met", on: ["ACME-2"], at: AT },
    status: "ready",
    hold: undefined,
    effects: [],
    check: (n) => expect(n.unmetDeps).toEqual(["ACME-4"]),
  },
  {
    name: "runLost with auto resume restarts through the drip",
    from: task({ status: "running" }),
    event: { type: "runLost", at: AT, autoResume: true },
    status: "running",
    hold: undefined,
    effects: ["runs.start"],
  },
  {
    name: "runLost with auto resume off holds on an error",
    from: task({ status: "running" }),
    event: { type: "runLost", at: AT, autoResume: false },
    status: "running",
    hold: "error",
    effects: ["dropPendingShip", ...PAUSED],
    check: (n) => expect(n.hold).toMatchObject({ phase: "restart" }),
  },
];

describe("transition table", () => {
  it.each(ROWS)("$name", (row) => {
    const t = ok(transition(row.from, row.event));
    expect(t.next.status).toBe(row.status);
    expect(t.next.hold?.cause).toBe(row.hold);
    expect(effectsOf(t)).toEqual(row.effects);
    row.check?.(t.next);
  });
});

/** The statuses each event is accepted in on a task with no hold (hold rules are tested below). */
const LEGAL: [LifecycleEvent, LifecycleStatus[]][] = [
  [{ type: "wishStart" }, ["inbox", "ready"]],
  [{ type: "start", by: "owner" }, ["inbox", "ready", "running"]],
  [{ type: "sendBack", by: "owner" }, ["review", "mr"]],
  [{ type: "ownerStop", at: AT }, ["running", "review"]],
  [{ type: "captainStop", at: AT }, ["running", "review"]],
  [{ type: "autonomousOff", at: AT, mode: "now" }, ["running", "review"]],
  [{ type: "runPaused", hold: SAMPLES.offline }, ["running", "review"]],
  [{ type: "runResumed" }, ["running", "review"]],
  [{ type: "holdPlaced", hold: SAMPLES.offline }, ["inbox", "ready", "running", "review"]],
  [{ type: "agentsIdle" }, ["running"]],
  [{ type: "processEnded" }, ["review"]],
  [{ type: "changeAndReview" }, ["inbox"]],
  [{ type: "mrOpened" }, ["inbox", "ready", "running", "review"]],
  [{ type: "mrClosedUnmerged" }, ["mr"]],
  [{ type: "close" }, ["inbox", "ready", "running", "review", "mr"]],
  [{ type: "reopen", to: "review" }, ["done"]],
  [{ type: "dependencyChanged", change: "closed-unmerged", on: ["ACME-2"], at: AT }, ["inbox", "ready"]],
  [{ type: "dependencyChanged", change: "removed", on: ["ACME-2"], at: AT }, ["inbox", "ready"]],
  [{ type: "dependencyChanged", change: "met", on: ["ACME-2"], at: AT }, ["inbox", "ready"]],
  [{ type: "runLost", at: AT, autoResume: true }, ["running"]],
];

describe("illegal transitions are refused", () => {
  const cases = LEGAL.flatMap(([event, legal]) =>
    ALL.filter((s) => !legal.includes(s)).map((status) => ({
      name: `${event.type} on ${status}`,
      event,
      status,
    })),
  );

  it.each(cases)("$name", ({ event, status }) => {
    const r = refused(transition(task({ status }), event));
    expect(r.code).toBe("wrong-status");
  });
});

const READING: ClearReading = {
  now: "2026-10-05T12:00:00.000Z",
  online: false,
  accounts: {},
  budgetHasRoom: false,
  autonomous: "off",
  runAtStep: false,
};

describe("lifting a hold", () => {
  const WHO = ["owner", "captain", "majhi"] as const;
  const CAPTAIN_CANNOT_LIFT: HoldCause[] = [
    "owner-stop",
    "loop-guard",
    "dependency-closed",
    "dependency-removed",
  ];
  /** Everything majhi can read for itself, so the cause's own condition holds. */
  const FULL: ClearReading = {
    ...READING,
    online: true,
    budgetHasRoom: true,
    autonomous: "on",
    runAtStep: true,
    slotFree: true,
    anyAccountUp: true,
    lastActivityAt: "2026-10-05T11:00:00.000Z",
    resolvedTasks: ["ACME-2", "ACME-1"],
    accounts: { "claude-acme": { signedIn: true } },
  };

  describe.each(CAUSES)("%s", (cause) => {
    it.each(WHO)("by %s is allowed exactly when the table lists them", (by) => {
      const from = task({ status: "running", hold: hold(cause) });
      const r = transition(
        from,
        by === "majhi" ? { type: "holdCleared", by, reading: FULL } : { type: "holdCleared", by },
      );
      // The captain never lifts an owner stop, a loop guard or a closed or removed dependency.
      if (by === "captain" && CAPTAIN_CANNOT_LIFT.includes(cause))
        expect(refused(r).code).toBe("not-allowed");
      // Majhi lifts only a hold whose condition is met.
      if (by === "majhi" && liftersOf(hold(cause)).includes("majhi"))
        expect(refused(transition(from, { type: "holdCleared", by, reading: READING })).code).toBe(
          "condition-not-met",
        );
      if (liftersOf(hold(cause)).includes(by)) expect(ok(r).next.hold).toBeUndefined();
      else {
        const refusal = refused(r);
        expect(refusal.code).toBe("not-allowed");
        expect(refusal.text).toBe(sentenceOf(hold(cause)));
      }
    });
  });
});

/**
 * Reachability: from every start state, apply every event in a fixed set until no new state
 * appears, and check what must hold in all of them.
 */
describe("invariants over every reachable state", () => {
  const holds: Hold[] = CAUSES.map(hold);
  const EVENTS: LifecycleEvent[] = [
    { type: "wishStart" },
    { type: "start", by: "owner" },
    { type: "sendBack", by: "owner" },
    { type: "ownerStop", at: AT },
    { type: "captainStop", at: AT },
    { type: "autonomousOff", at: AT, mode: "now" },
    { type: "autonomousOff", at: AT, mode: "step" },
    { type: "autonomousOn", at: AT, resume: true },
    { type: "autonomousOn", at: AT, resume: false },
    ...holds.flatMap((h): LifecycleEvent[] => [
      { type: "runPaused", hold: h },
      { type: "holdPlaced", hold: h },
    ]),
    { type: "runResumed" },
    { type: "holdCleared", by: "owner" },
    { type: "holdCleared", by: "captain" },
    {
      type: "holdCleared",
      by: "majhi",
      reading: {
        ...READING,
        online: true,
        budgetHasRoom: true,
        runAtStep: true,
        autonomous: "on",
        lastActivityAt: "2027-01-01T00:00:00.000Z",
        accounts: { "claude-acme": { signedIn: true } },
      },
    },
    { type: "agentsIdle" },
    { type: "processEnded" },
    { type: "changeAndReview" },
    { type: "mrOpened" },
    { type: "mrClosedUnmerged" },
    { type: "close" },
    { type: "reopen", to: "review" },
    { type: "reopen", to: "inbox" },
    { type: "dependencyChanged", change: "closed-unmerged", on: ["ACME-2"], at: AT },
    { type: "dependencyChanged", change: "removed", on: ["ACME-2"], at: AT },
    { type: "dependencyChanged", change: "met", on: ["ACME-2"], at: AT },
    { type: "runLost", at: AT, autoResume: true },
    { type: "runLost", at: AT, autoResume: false },
  ];

  const explore = (): { states: TaskState[]; refusals: Refusal[] } => {
    const seen = new Map<string, TaskState>();
    const refusals: Refusal[] = [];
    const queue: TaskState[] = [];
    const add = (s: TaskState): void => {
      const key = JSON.stringify(s);
      if (!seen.has(key)) {
        seen.set(key, s);
        queue.push(s);
      }
    };
    for (const status of ["inbox", "ready"] as const)
      for (const unmet of [[], ["ACME-2"]])
        for (const live of [false, true]) add(task({ status, unmetDeps: unmet, hasLiveRun: live }));
    for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
      for (const e of EVENTS) {
        const r = transition(s, e);
        if (isRefusal(r)) refusals.push(r);
        else add(r.next);
      }
    }
    return { states: [...seen.values()], refusals };
  };

  const { states } = explore();

  it("no held task can be started or sent back, none with unmet dependencies is started, and every hold can be lifted by someone", () => {
    for (const s of states.filter((x) => x.hold !== undefined)) {
      for (const e of [
        { type: "start", by: "owner" },
        { type: "sendBack", by: "owner" },
      ] as const) {
        const r = transition(s, e);
        if (!isRefusal(r)) throw new Error(`${JSON.stringify(s)} accepted ${e.type}`);
      }
    }
    for (const s of states.filter(
      (x) => x.unmetDeps.length > 0 && (x.status === "inbox" || x.status === "ready"),
    )) {
      const r = transition(s, { type: "start", by: "owner" });
      expect(isRefusal(r)).toBe(true);
    }
    for (const s of states.filter((x) => x.hold !== undefined)) {
      const lifters = liftersOf(s.hold as Hold);
      const cleared = lifters.some((by) => {
        const event: LifecycleEvent =
          by === "majhi"
            ? {
                type: "holdCleared",
                by,
                reading: {
                  ...READING,
                  online: true,
                  budgetHasRoom: true,
                  runAtStep: true,
                  autonomous: "on",
                  lastActivityAt: "2027-01-01T00:00:00.000Z",
                  accounts: { "claude-acme": { signedIn: true } },
                },
              }
            : { type: "holdCleared", by };
        const r = transition(s, event);
        return !isRefusal(r) && r.next.hold === undefined;
      });
      expect(cleared).toBe(true);
    }
  });
});
