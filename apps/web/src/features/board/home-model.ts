import {
  type BoardCounts,
  type CaptainAction,
  type CiState,
  type HomeBackground,
  type HomeCheck,
  lifecycle,
  type OriginKind,
  type OwnerDecision,
  PRIVATE,
  type TaskPriority,
  type TaskSummary,
  type TaskType,
} from "@majhi/shared";
import { primaryOption, rowTitle, workspaceOf } from "../decisions/model";
import type { BannerAction } from "../shell/model";
import { type CheckState, checkState } from "./check-state";
import { compareTaskIds, partOf, plainTitle, waitsOnSubtasks } from "./model";

type Blocker = lifecycle.Blocker;

/**
 * The Tasks board, sorted by who holds the ball. Pure: the screen reads the queries and hands them here, so the
 * assignment of every task to one section, the order inside a section and the one verb of each row
 * are decided in one place and can be checked without a browser.
 */

export type SectionId = "needs" | "running" | "waiting" | "shipping" | "next" | "triage" | "captain" | "done";

export const SECTION_ORDER: readonly SectionId[] = [
  "needs",
  "running",
  "waiting",
  "shipping",
  "next",
  "triage",
  "captain",
  "done",
];

export const SECTION_LABEL: Record<SectionId, string> = {
  needs: "Needs you",
  running: "Running",
  waiting: "Waiting",
  shipping: "Shipping",
  next: "Up next",
  triage: "Ideas",
  captain: "Captain did today",
  done: "Done",
};

/** The word of a section on a tree row, where the header is not drawn. */
export const SECTION_WORD: Record<SectionId, string> = {
  needs: "Needs you",
  running: "Running",
  waiting: "Waiting",
  shipping: "Shipping",
  next: "Up next",
  triage: "Idea",
  captain: "Captain",
  done: "Done",
};

/** Sections that stay shut until the owner turns them on. */
export const COLLAPSED_BY_DEFAULT: ReadonlySet<SectionId> = new Set(["triage", "captain", "done"]);

/** How many cards a column shows before "+n more". A column scrolls, but a hundred cards need not all be drawn. */
export const SECTION_CAP = 30;

// Facts the screen reads next to the task list ------------------------------

export interface MrFact {
  project: string;
  number: number;
  url: string;
  ci: CiState;
}

export interface DoingFact {
  agent: string;
  text?: string | undefined;
  /** When the turn started (UTC ISO). */
  since?: string | undefined;
}

export interface HomeInput {
  tasks: readonly TaskSummary[];
  decisions: readonly OwnerDecision[];
  /** The tasks an agent works on now (`decisions.list` counts). */
  working: ReadonlySet<string>;
  blockers: ReadonlyMap<string, Blocker | null>;
  mrs: ReadonlyMap<string, MrFact>;
  /** Open merge requests per task beyond the first. */
  mrExtra: ReadonlyMap<string, number>;
  doing: ReadonlyMap<string, DoingFact>;
  /** The merge gate verdict and hand-off state of each review task. */
  checks: ReadonlyMap<string, HomeCheck>;
  /** Hand-off checks, background processes and previews that run now. */
  background: readonly HomeBackground[];
  captain: readonly CaptainAction[];
  /** Captain actions that merged a task and can be undone, by task. */
  undoOf: ReadonlyMap<string, number>;
  org: string | undefined;
  query: string;
  now: number;
  /** The chip filters of the screen: what the task is, where it came from, which part of the system it touches. */
  type?: TaskType | undefined;
  source?: OriginKind | undefined;
  area?: string | undefined;
  /** The names of the parts of the system each task touches (`tasks.areas`). */
  areas?: ReadonlyMap<string, readonly string[]> | undefined;
  /**
   * The board nests a subtask in its parent's card, so it is no card of its own: a task whose parent has
   * a card is left out, unless the subtask itself needs the owner or ships. The tree nests by its own rule.
   */
  nest?: { opened: ReadonlySet<SectionId> } | undefined;
}

// Section of a task ---------------------------------------------------------

export type TaskSection = Exclude<SectionId, "captain">;

/** A parent whose subtasks are being worked on is running, though no agent holds the parent itself. */
function subtasksRunning(task: TaskSummary): boolean {
  return task.trail.some((step) => step.kind === "children" && step.tone === "working");
}

/**
 * The one section a task belongs to, or undefined when the board does not draw it (a quiet chat). A
 * task a decision waits on is Needs you, whatever its status. A paused task goes by who ends its
 * hold: the owner (Needs you) or majhi on a condition it watches (Waiting). A task that waits on
 * another task, or on its own subtasks, is Waiting. Done tasks are Done; the screen keeps only
 * today's.
 */
export function sectionOf(
  task: TaskSummary,
  ctx: { asking: ReadonlySet<string>; working: ReadonlySet<string> },
): TaskSection | undefined {
  if (ctx.asking.has(task.id)) return "needs";
  if (task.chat === true) return undefined;
  switch (task.status) {
    case "done":
      return "done";
    case "mr":
      return "shipping";
    case "running":
      if (ctx.working.has(task.id)) return "running";
      if (waitsOnSubtasks(task)) return subtasksRunning(task) ? "running" : "waiting";
      return "next";
    case "paused":
      if (waitsOnSubtasks(task)) return subtasksRunning(task) ? "running" : "waiting";
      return task.hold?.lifter === "system" ? "waiting" : "needs";
    case "review":
      return "next";
    case "ready":
      return task.waitingOn.length > 0 ? "waiting" : "next";
    case "inbox":
      if (lifecycle.isUntriaged(task)) return "triage";
      return task.waitingOn.length > 0 ? "waiting" : "next";
  }
}

// Rows ----------------------------------------------------------------------

export interface NeedsItem {
  decision: OwnerDecision;
  /** The checks of the decision's task, for a ship decision. */
  check: HomeCheck | undefined;
  /** How many open tasks wait for this decision's task. */
  blocks: number;
}
/** A paused task only the owner can lift: no decision for it, but it waits on a click. */
export interface HeldItem {
  task: TaskSummary;
}
export interface RunningItem {
  task: TaskSummary;
  doing: DoingFact | undefined;
}
/** A task that waits for something that is not the owner: a hold majhi lifts, another task, its subtasks. */
export interface WaitingItem {
  task: TaskSummary;
}
/** Work with no agent turn: a hand-off check, a process, a preview. One row each. */
export interface BackgroundItem {
  task: TaskSummary;
  work: HomeBackground;
}
export interface ShippingItem {
  task: TaskSummary;
  mr: MrFact | undefined;
  extra: number;
}
export interface QueuedItem {
  task: TaskSummary;
  /** Undefined until `tasks.blockers` has answered, and for a task that is not ready or inbox. */
  blocker: Blocker | null | undefined;
}
export interface DoneItem {
  task: TaskSummary;
  undoId: number | undefined;
}

export interface HomeSections {
  needs: NeedsItem[];
  /** Listed in Needs you after the decisions. */
  held: HeldItem[];
  running: RunningItem[];
  waiting: WaitingItem[];
  /** Listed in Running now after the agents. */
  background: BackgroundItem[];
  shipping: ShippingItem[];
  next: QueuedItem[];
  triage: QueuedItem[];
  captain: CaptainAction[];
  done: DoneItem[];
}

/** What the strip says: counts of the workspace filter, before the text filter narrows the rows. */
export type HomeTotals = Record<SectionId, number> & {
  /** Agents in a turn now, plus the background work that runs. */
  working: number;
};

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };
const priorityRank = (p: TaskPriority | undefined) => PRIORITY_RANK[p ?? "normal"];

/** The open tasks that wait for each task to finish. */
export function waitersOf(tasks: readonly TaskSummary[]): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.status === "done") continue;
    for (const dep of t.waitingOn) by.set(dep, [...(by.get(dep) ?? []), t.id]);
  }
  return by;
}

/** Tasks that wait for this task to finish: the number "blocks others" sorts by. */
export function blockedBy(tasks: readonly TaskSummary[]): Map<string, number> {
  return new Map([...waitersOf(tasks)].map(([id, waiters]) => [id, waiters.length]));
}

function needsOrder(a: NeedsItem, b: NeedsItem, priority: (id: string | undefined) => number): number {
  const incident = (n: NeedsItem) => (n.decision.kind === "incident" ? 0 : 1);
  return (
    incident(a) - incident(b) ||
    b.blocks - a.blocks ||
    priority(a.decision.task) - priority(b.decision.task) ||
    a.decision.at.localeCompare(b.decision.at) ||
    a.decision.id.localeCompare(b.decision.id)
  );
}

/** Rows of Running: longest running first (the turn's start, else the last change). */
function runningOrder(a: RunningItem, b: RunningItem): number {
  const since = (r: RunningItem) => r.doing?.since ?? r.task.updatedAt;
  return since(a).localeCompare(since(b)) || a.task.id.localeCompare(b.task.id);
}

const CI_RANK: Record<CiState, number> = { failing: 0, pending: 1, none: 2, passing: 3 };
function shippingOrder(a: ShippingItem, b: ShippingItem): number {
  const ci = (s: ShippingItem) => CI_RANK[s.mr?.ci ?? "none"];
  return (
    ci(a) - ci(b) || a.task.updatedAt.localeCompare(b.task.updatedAt) || a.task.id.localeCompare(b.task.id)
  );
}

/** How ready a queued task is to start: nothing in the way, then a wait that ends by itself, then one the owner must fix. */
export function startRank(blocker: Blocker | null | undefined): number {
  switch (blocker?.gate) {
    case undefined:
    case "nobody":
      return 0;
    case "slots":
    case "tasks-at-once":
    case "machine":
      return 1;
    case "account":
    case "budget":
      return 2;
    case "dependency":
      return 3;
    case "untriaged":
      return 4;
  }
}

/** Rank of a queued row: tasks that can start, then a task with no agent on it, last. */
function queuedRank(item: QueuedItem): number {
  return item.task.status === "ready" || item.task.status === "inbox" ? startRank(item.blocker) : 5;
}

function queuedOrder(a: QueuedItem, b: QueuedItem): number {
  return (
    queuedRank(a) - queuedRank(b) ||
    priorityRank(a.task.priority) - priorityRank(b.task.priority) ||
    (a.task.due ?? "9999").localeCompare(b.task.due ?? "9999") ||
    a.task.updatedAt.localeCompare(b.task.updatedAt) ||
    a.task.id.localeCompare(b.task.id)
  );
}

const newestFirst = (a: TaskSummary, b: TaskSummary) =>
  b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);

function localMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The last day: what the captain did, shown while the owner may still want to check it. */
const CAPTAIN_WINDOW_MS = 24 * 3_600_000;

function matches(query: string, ...fields: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || fields.some((f) => f?.toLowerCase().includes(q) === true);
}

export function decisionTitle(d: OwnerDecision): string {
  return plainTitle(d.taskTitle ?? rowTitle(d));
}

/** Longest first: a task's waiting is ordered by how long it has waited. */
function waitingOrder(a: WaitingItem, b: WaitingItem): number {
  return a.task.updatedAt.localeCompare(b.task.updatedAt) || a.task.id.localeCompare(b.task.id);
}

/** Every section of the board, each task in exactly one, ordered, with the chip, workspace and text filters applied. */
export function buildHome(input: HomeInput): { sections: HomeSections; totals: HomeTotals } {
  const { org, query, now } = input;
  const areas = input.areas ?? new Map<string, readonly string[]>();
  const inScope = (t: TaskSummary) => org === undefined || (t.org ?? PRIVATE) === org;
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const chips = input.type !== undefined || input.source !== undefined || input.area !== undefined;
  const passesChips = (t: TaskSummary) =>
    (input.type === undefined || t.typing?.type === input.type) &&
    (input.source === undefined || t.origin?.kind === input.source) &&
    (input.area === undefined || (areas.get(t.id) ?? []).includes(input.area));
  const tasks = input.tasks.filter((t) => inScope(t) && passesChips(t));
  // A pause majhi lifts by itself is not a question for the owner: its task waits, in Waiting.
  const waitsForMajhi = (id: string | undefined) =>
    id !== undefined && byId.get(id)?.hold?.lifter === "system";
  const decisions = input.decisions.filter((d) => {
    if (d.kind === "paused" && waitsForMajhi(d.task)) return false;
    if (org !== undefined && workspaceOf(d) !== org) return false;
    // A decision with no task has no type, source or area: a chip filter hides it.
    if (!chips) return true;
    const task = d.task === undefined ? undefined : byId.get(d.task);
    return task !== undefined && passesChips(task);
  });
  const asking = new Set(
    input.decisions.flatMap((d) =>
      d.task === undefined || (d.kind === "paused" && waitsForMajhi(d.task)) ? [] : [d.task],
    ),
  );
  const blocks = blockedBy(input.tasks);
  const midnight = localMidnight(now);

  const needs: NeedsItem[] = decisions.map((decision) => ({
    decision,
    blocks: decision.task === undefined ? 0 : (blocks.get(decision.task) ?? 0),
    check: decision.task === undefined ? undefined : input.checks.get(decision.task),
  }));
  needs.sort((a, b) =>
    needsOrder(a, b, (id) => priorityRank(id === undefined ? undefined : byId.get(id)?.priority)),
  );

  const held: HeldItem[] = [];
  const running: RunningItem[] = [];
  const waiting: WaitingItem[] = [];
  const shipping: ShippingItem[] = [];
  const next: QueuedItem[] = [];
  const triage: QueuedItem[] = [];
  const done: DoneItem[] = [];
  for (const task of tasks) {
    const section = sectionOf(task, { asking, working: input.working });
    const blocker = input.blockers.get(task.id);
    switch (section) {
      case "needs":
        // A task a decision waits on is in `needs` already; only a hold the owner lifts is a row of its own.
        if (!asking.has(task.id)) held.push({ task });
        break;
      case "running":
        running.push({ task, doing: input.doing.get(task.id) });
        break;
      case "waiting":
        waiting.push({ task });
        break;
      case "shipping":
        shipping.push({ task, mr: input.mrs.get(task.id), extra: input.mrExtra.get(task.id) ?? 0 });
        break;
      case "next":
        // A task in review whose checks run is shown once, as the Checking row in Running.
        if (task.status === "review" && input.checks.get(task.id)?.activity !== undefined) break;
        next.push({ task, blocker });
        break;
      case "triage":
        triage.push({ task, blocker });
        break;
      case "done":
        if (Date.parse(task.updatedAt) >= midnight) done.push({ task, undoId: input.undoOf.get(task.id) });
        break;
      default:
        break;
    }
  }
  if (input.nest !== undefined) {
    const shown = (section: SectionId) =>
      !COLLAPSED_BY_DEFAULT.has(section) || input.nest?.opened.has(section) === true;
    const cards = new Set<string>([
      ...needs.flatMap((n) => (n.decision.task === undefined ? [] : [n.decision.task])),
      ...held.map((h) => h.task.id),
      ...shipping.map((s) => s.task.id),
      ...running.map((r) => r.task.id),
      ...waiting.map((w) => w.task.id),
      ...next.map((n) => n.task.id),
      ...(shown("triage") ? triage.map((t) => t.task.id) : []),
      ...(shown("done") ? done.map((d) => d.task.id) : []),
    ]);
    // A subtask in a section a card sums up is nested; one whose parent is itself nested has no card to nest in.
    const parentIn = (task: TaskSummary, set: ReadonlySet<string>) => {
      const parent = partOf(task);
      return parent !== undefined && parent !== task.id && set.has(parent);
    };
    const nestedOnce = new Set<string>();
    for (const list of [running, waiting, next, triage, done]) {
      for (const row of list) if (parentIn(row.task, cards)) nestedOnce.add(row.task.id);
    }
    const roots = new Set([...cards].filter((id) => !nestedOnce.has(id)));
    const keep = <T extends { task: TaskSummary }>(rows: T[]) => rows.filter((r) => !parentIn(r.task, roots));
    running.splice(0, running.length, ...keep(running));
    waiting.splice(0, waiting.length, ...keep(waiting));
    next.splice(0, next.length, ...keep(next));
    triage.splice(0, triage.length, ...keep(triage));
    done.splice(0, done.length, ...keep(done));
  }
  held.sort((a, b) => a.task.updatedAt.localeCompare(b.task.updatedAt) || a.task.id.localeCompare(b.task.id));
  running.sort(runningOrder);
  waiting.sort(waitingOrder);
  const background: BackgroundItem[] = input.background
    .flatMap((work) => {
      const task = byId.get(work.task);
      return task === undefined || !inScope(task) || !passesChips(task) ? [] : [{ task, work }];
    })
    .toSorted((a, b) => a.work.since.localeCompare(b.work.since) || a.task.id.localeCompare(b.task.id));
  shipping.sort(shippingOrder);
  next.sort(queuedOrder);
  triage.sort(
    (a, b) => a.task.updatedAt.localeCompare(b.task.updatedAt) || a.task.id.localeCompare(b.task.id),
  );
  done.sort((a, b) => newestFirst(a.task, b.task));

  // What the captain did has no type or source of its own: a chip filter leaves it out.
  const captain = chips
    ? []
    : input.captain
        .filter(
          (a) =>
            a.outcome === "done" &&
            a.undo !== "done" &&
            now - Date.parse(a.at) < CAPTAIN_WINDOW_MS &&
            (org === undefined || a.org === org),
        )
        .toSorted((a, b) => b.at.localeCompare(a.at) || b.id - a.id);

  const totals: HomeTotals = {
    needs: needs.length + held.length,
    running: running.length + background.length,
    waiting: waiting.length,
    shipping: shipping.length,
    next: next.length,
    triage: triage.length,
    captain: captain.length,
    done: done.length,
    working: running.length + background.length,
  };

  const sections: HomeSections = {
    needs: needs.filter((n) =>
      matches(query, n.decision.task, decisionTitle(n.decision), n.decision.sentence),
    ),
    held: held.filter((h) => matches(query, h.task.id, h.task.title)),
    running: running.filter((r) => matches(query, r.task.id, r.task.title)),
    background: background.filter((b) => matches(query, b.task.id, b.task.title)),
    waiting: waiting.filter((w) => matches(query, w.task.id, w.task.title)),
    shipping: shipping.filter((s) => matches(query, s.task.id, s.task.title)),
    next: next.filter((q) => matches(query, q.task.id, q.task.title)),
    triage: triage.filter((q) => matches(query, q.task.id, q.task.title)),
    captain: captain.filter((a) => matches(query, a.task, a.text)),
    done: done.filter((d) => matches(query, d.task.id, d.task.title)),
  };
  return { sections, totals };
}

/** True when counts of `decisions.list` and the Needs you section agree, for the workspace filter. */
export function needsAgrees(
  sections: Pick<HomeSections, "needs">,
  counts: BoardCounts,
  org: string | undefined,
): boolean {
  const expected = org === undefined ? counts.needsYou : (counts.orgs[org]?.needsYou ?? 0);
  return sections.needs.length === expected;
}

// Words ---------------------------------------------------------------------

/** "PRV-142", "PRV-142, PRV-143", "PRV-142, PRV-143 +1". */
export function idList(ids: readonly string[]): string {
  const shown = ids.slice(0, 2).join(", ");
  const more = ids.length - 2;
  return more > 0 ? `${shown} +${more}` : shown;
}

/** The one-word state chip of a queued row. */
export function queuedChip(blocker: Blocker | null | undefined): string {
  switch (blocker?.gate) {
    case undefined:
    case "nobody":
      return "next";
    case "slots":
    case "tasks-at-once":
    case "machine":
      return "waiting";
    case "dependency":
      return "blocked";
    case "account":
      return "access";
    case "budget":
      return "budget";
    case "untriaged":
      return "triage";
  }
}

/** The reason a queued task waits, in a sentence. `orgName` words a workspace id. */
export function blockerText(blocker: Blocker | null | undefined, orgName: (id: string) => string): string {
  if (blocker === undefined || blocker === null) return "Waiting to start";
  switch (blocker.gate) {
    case "dependency":
      return `Waits on ${idList(blocker.on)}`;
    case "account":
      return blocker.why === "signed-out"
        ? `${blocker.account} is signed out`
        : `${blocker.account} is at its usage limit`;
    case "machine":
      return blocker.why === "memory"
        ? "Starts when the computer has memory free"
        : "Starts when the computer is less busy";
    case "slots":
      return blocker.scope === "account"
        ? `Starts when a slot frees on ${blocker.account} (${blocker.inUse} of ${blocker.max})`
        : `Starts when a slot frees (${blocker.inUse} of ${blocker.max})`;
    case "tasks-at-once":
      return `${orgName(blocker.org)} runs ${blocker.max} ${blocker.max === 1 ? "task" : "tasks"} at a time: ${idList(blocker.running)} first`;
    case "budget":
      if (blocker.period === "month") return "The monthly ceiling is reached";
      if (blocker.scope === "org") return `${orgName(blocker.scopeId ?? "")} reached its budget for today`;
      if (blocker.scope === "reserve")
        return `${blocker.scopeId ?? "The account"} is kept in reserve for you`;
      return "Today's budget is used up";
    case "untriaged":
      return blocker.missing.includes("repo") ? "No priority or repo yet" : "No priority yet";
    case "nobody":
      return blocker.autopilot === "on"
        ? "Next in line, the captain picks it up"
        : "Not started, Auto-pilot is off";
  }
}

// Actions -------------------------------------------------------------------

/**
 * What a numbered button or key does. The first is the row's primary verb: the one that fixes the
 * reason the row is there. The screen runs them; this says which.
 */
export type ActionSpec =
  | { kind: "answer"; option: string; label: string }
  | { kind: "go"; action: BannerAction; label: string }
  | { kind: "start"; task: string; label: string }
  | { kind: "stop"; task: string; label: string }
  | { kind: "merge"; task: string; label: string }
  | { kind: "fix-ci"; task: string; label: string }
  /** Run the task's hand-off checks again. */
  | { kind: "recheck"; task: string; label: string }
  /** Nothing to press: the row shows a spinner and the time. */
  | { kind: "wait"; label: string }
  | { kind: "undo"; id: number; label: string };

const open = (task: string, label: string): ActionSpec => ({
  kind: "go",
  action: { kind: "task", id: task },
  label,
});

/** At most three numbered actions, as the keys 1 to 3 reach them. */
const MAX_ACTIONS = 3;

/** Answers of a decision as buttons, then its Open. The primary option leads. */
export function needsActions(
  decision: OwnerDecision,
  blocked: Readonly<Record<string, string>> | undefined,
  check?: HomeCheck | undefined,
): ActionSpec[] {
  const ship = decision.kind === "ship";
  if (ship && check !== undefined && decision.task !== undefined) {
    const staged = checkActions(decision, checkState(check));
    if (staged !== undefined) return staged;
  }
  const lead = primaryOption(decision, blocked);
  const options = decision.options
    .filter((o) => o.text !== true && blocked?.[o.id] === undefined && (!ship || o.primary === true))
    .toSorted((a, b) => Number(b.id === lead?.id) - Number(a.id === lead?.id));
  const openLabel = ship ? "Review" : decision.kind === "question" ? "Answer" : "Open";
  const open: ActionSpec = { kind: "go", action: linkAction(decision), label: openLabel };
  const answers: ActionSpec[] = options.map((o) => ({ kind: "answer", option: o.id, label: o.label }));
  // A question with typed answers only: the first action opens it, where the reply box is.
  return [...answers, open].slice(0, MAX_ACTIONS);
}

/**
 * The buttons of a ship decision while its checks are not green: the verdict says which one leads.
 * Undefined when the checks are green: the decision's own buttons stand.
 */
function checkActions(decision: OwnerDecision, state: CheckState): ActionSpec[] | undefined {
  const task = decision.task;
  if (task === undefined || state.button === "merge") return undefined;
  const link: ActionSpec = { kind: "go", action: linkAction(decision), label: "Review" };
  const anyway: ActionSpec[] = state.mergeAnyway
    ? [{ kind: "go", action: linkAction(decision), label: "Merge anyway" }]
    : [];
  switch (state.button) {
    case "wait":
      return [{ kind: "wait", label: state.label }, link];
    case "see-failure":
      return [{ kind: "go", action: linkAction(decision), label: state.label }, ...anyway];
    case "check-again":
      return [{ kind: "recheck", task, label: state.label } satisfies ActionSpec, link, ...anyway].slice(
        0,
        MAX_ACTIONS,
      );
  }
}

function linkAction(decision: OwnerDecision): BannerAction {
  const link = decision.link;
  switch (link.kind) {
    case "task":
      return { kind: "task", id: link.id, ...(link.item === undefined ? {} : { item: link.item }) };
    case "chat":
      return { kind: "chat", id: link.id };
    case "captain":
      return { kind: "page", to: "/captain" };
    case "limits":
      return { kind: "page", to: "/limits" };
    case "account":
      return { kind: "page", to: "/accounts", search: { account: link.id } };
    case "playbooks":
      return { kind: "page", to: "/playbooks" };
    case "watch":
      return { kind: "page", to: "/watch" };
    case "setup":
      return { kind: "page", to: "/setup", search: { section: link.section } };
  }
}

export function backgroundActions(item: BackgroundItem): ActionSpec[] {
  return [open(item.task.id, "Watch")];
}

export function runningActions(item: RunningItem): ActionSpec[] {
  const id = item.task.id;
  return [open(id, "Watch"), { kind: "stop", task: id, label: "Stop" }];
}

/** A hold only the owner lifts: Resume leads, then the task. */
export function heldActions(item: HeldItem): ActionSpec[] {
  const id = item.task.id;
  return [{ kind: "start", task: id, label: "Resume" }, open(id, "Open")];
}

/** Waiting for something that is not the owner: the task is the place to look; a held one can be resumed by hand. */
export function waitingActions(item: WaitingItem): ActionSpec[] {
  const id = item.task.id;
  return item.task.status === "paused"
    ? [open(id, "Open"), { kind: "start", task: id, label: "Resume" }]
    : [open(id, "Open")];
}

export function shippingActions(item: ShippingItem): ActionSpec[] {
  const id = item.task.id;
  const ci = item.mr?.ci;
  if (ci === "failing") return [{ kind: "fix-ci", task: id, label: "Fix with agent" }, open(id, "Open")];
  if (ci === "passing" && item.task.autonomous !== true)
    return [{ kind: "merge", task: id, label: "Merge" }, open(id, "Open")];
  return [open(id, "Open")];
}

export function queuedActions(item: QueuedItem): ActionSpec[] {
  const id = item.task.id;
  const blocker = item.blocker;
  const start: ActionSpec = { kind: "start", task: id, label: "Start now" };
  switch (blocker?.gate) {
    case "dependency": {
      const dep = blocker.on[0];
      return dep === undefined ? [open(id, "Open")] : [open(dep, `Open ${dep}`), open(id, "Open")];
    }
    case "account":
      return [
        {
          kind: "go",
          action: { kind: "page", to: "/accounts", search: { account: blocker.account } },
          label: blocker.why === "signed-out" ? "Sign in" : "Open account",
        },
        start,
      ];
    case "budget":
      return [
        { kind: "go", action: { kind: "page", to: "/limits" }, label: "Raise limit" },
        open(id, "Open"),
      ];
    case "untriaged":
      return [{ kind: "start", task: id, label: "Start" }, open(id, "Open")];
    default:
      // Running, paused or finished with no one to ask: a start has nothing to do, the task is the place to look.
      return item.task.status === "ready" || item.task.status === "inbox"
        ? [start, open(id, "Open")]
        : [open(id, "Open")];
  }
}

export function captainActions(action: CaptainAction): ActionSpec[] {
  const verify: ActionSpec =
    action.task === undefined
      ? { kind: "go", action: { kind: "page", to: "/captain" }, label: "Verify" }
      : open(action.task, "Verify");
  return action.undo === "yes" ? [verify, { kind: "undo", id: action.id, label: "Undo" }] : [verify];
}

export function doneActions(item: DoneItem): ActionSpec[] {
  const o = open(item.task.id, "Open");
  return item.undoId === undefined ? [o] : [o, { kind: "undo", id: item.undoId, label: "Undo" }];
}

// The flat list the screen draws and the keys walk ---------------------------

export interface ListView {
  /** The toggled sections: Ideas, Done and Captain stay out of the board until the owner turns them on. */
  opened: ReadonlySet<SectionId>;
  /** Sections whose "+n more" was opened. */
  all: ReadonlySet<SectionId>;
}

export type Entry =
  | { type: "header"; key: string; section: SectionId; count: number }
  | { type: "needs"; key: string; section: "needs"; item: NeedsItem }
  | { type: "held"; key: string; section: "needs"; item: HeldItem }
  | { type: "running"; key: string; section: "running"; item: RunningItem }
  | { type: "background"; key: string; section: "running"; item: BackgroundItem }
  | { type: "waiting"; key: string; section: "waiting"; item: WaitingItem }
  | { type: "shipping"; key: string; section: "shipping"; item: ShippingItem }
  | { type: "next"; key: string; section: "next"; item: QueuedItem }
  | { type: "triage"; key: string; section: "triage"; item: QueuedItem }
  | { type: "captain"; key: string; section: "captain"; item: CaptainAction }
  | { type: "done"; key: string; section: "done"; item: DoneItem }
  | { type: "more"; key: string; section: SectionId; hidden: number };

export type RowEntry = Exclude<Entry, { type: "header" | "more" }>;

/** Whether a key can land on the entry: a row, or "+n more". A column head is only a heading. */
export function focusable(entry: Entry): boolean {
  return entry.type !== "header";
}

export function headerKey(section: SectionId): string {
  return `h:${section}`;
}

/** How many rows a section has. */
export function countOf(sections: HomeSections, section: SectionId): number {
  switch (section) {
    case "needs":
      return sections.needs.length + sections.held.length;
    case "running":
      return sections.running.length + sections.background.length;
    default:
      return sections[section].length;
  }
}

/** Every column in order, each with its head: a column with nothing in it is a head and no rows. The toggled ones only while on. */
export function buildEntries(sections: HomeSections, view: ListView): Entry[] {
  const out: Entry[] = [];
  for (const section of SECTION_ORDER) {
    if (COLLAPSED_BY_DEFAULT.has(section) && !view.opened.has(section)) continue;
    const count = countOf(sections, section);
    out.push({ type: "header", key: headerKey(section), section, count });
    const limit = view.all.has(section) ? count : SECTION_CAP;
    out.push(...rowsOf(sections, section).slice(0, limit));
    if (count > limit) out.push({ type: "more", key: `m:${section}`, section, hidden: count - limit });
  }
  return out;
}

function rowsOf(sections: HomeSections, section: SectionId): RowEntry[] {
  switch (section) {
    case "needs":
      return [
        ...sections.needs.map(
          (item): RowEntry => ({ type: "needs", key: `d:${item.decision.id}`, section, item }),
        ),
        ...sections.held.map((item): RowEntry => ({ type: "held", key: `t:${item.task.id}`, section, item })),
      ];
    case "running":
      return [
        ...sections.running.map(
          (item): RowEntry => ({ type: "running", key: `t:${item.task.id}`, section, item }),
        ),
        ...sections.background.map(
          (item): RowEntry => ({
            type: "background",
            key: `b:${item.task.id}:${item.work.kind}:${item.work.label}`,
            section,
            item,
          }),
        ),
      ];
    case "waiting":
      return sections.waiting.map((item) => ({ type: "waiting", key: `t:${item.task.id}`, section, item }));
    case "shipping":
      return sections.shipping.map((item) => ({ type: "shipping", key: `t:${item.task.id}`, section, item }));
    case "next":
      return sections.next.map((item) => ({ type: "next", key: `t:${item.task.id}`, section, item }));
    case "triage":
      return sections.triage.map((item) => ({ type: "triage", key: `t:${item.task.id}`, section, item }));
    case "captain":
      return sections.captain.map((item) => ({ type: "captain", key: `c:${item.id}`, section, item }));
    case "done":
      return sections.done.map((item) => ({ type: "done", key: `t:${item.task.id}`, section, item }));
  }
}

/** The numbered actions of a row, for the keys and the buttons alike. */
export function actionsOf(
  entry: RowEntry,
  blockedOf: (decision: string) => Readonly<Record<string, string>> | undefined = () => undefined,
): ActionSpec[] {
  switch (entry.type) {
    case "needs":
      return needsActions(entry.item.decision, blockedOf(entry.item.decision.id), entry.item.check);
    case "held":
      return heldActions(entry.item);
    case "running":
      return runningActions(entry.item);
    case "background":
      return backgroundActions(entry.item);
    case "waiting":
      return waitingActions(entry.item);
    case "shipping":
      return shippingActions(entry.item);
    case "next":
    case "triage":
      return queuedActions(entry.item);
    case "captain":
      return captainActions(entry.item);
    case "done":
      return doneActions(entry.item);
  }
}

/** The key after (or before) `current` among the focusable entries, staying at the ends. */
export function stepFocus(
  keys: readonly string[],
  current: string | undefined,
  by: 1 | -1,
): string | undefined {
  if (keys.length === 0) return undefined;
  const at = current === undefined ? -1 : keys.indexOf(current);
  if (at === -1) return by === 1 ? keys[0] : keys.at(-1);
  return keys[Math.min(Math.max(at + by, 0), keys.length - 1)];
}

/** The first focusable entry of the next (or previous) section, for Shift+J and Shift+K. */
export function jumpSection(
  entries: readonly Entry[],
  current: string | undefined,
  by: 1 | -1,
): string | undefined {
  const marks = entries.filter(focusable);
  if (marks.length === 0) return undefined;
  const sections: SectionId[] = [];
  for (const e of marks) if (sections.at(-1) !== e.section) sections.push(e.section);
  const now = marks.find((e) => e.key === current)?.section;
  const at = now === undefined ? -1 : sections.indexOf(now);
  const target = sections[Math.min(Math.max(at + by, 0), sections.length - 1)];
  if (by === -1 && now !== undefined) {
    // From the middle of a section, Shift+K goes to its start first.
    const first = marks.find((e) => e.section === now);
    if (first !== undefined && first.key !== current) return first.key;
  }
  return marks.find((e) => e.section === target)?.key;
}

// Relations: how a row connects to other tasks ---------------------------------

/** The task a row stands for and how it connects: its parent, its subtasks and the tasks it waits on, blocks or follows up. */
export interface Relation {
  task: string;
  parent: string | undefined;
  /** Subtasks: how many are done, of how many. Total 0 for a task without. */
  done: number;
  total: number;
  /** The tasks it waits for (their `depends-on` is not met yet). */
  waitsOn: readonly string[];
  /** The open tasks that wait for it. */
  blocks: readonly string[];
  /** The task it follows up. */
  followUpOf: string | undefined;
}

/** The task of a row, if it has one (a decision for the workspace and a captain action may have none). */
export function taskIdOf(entry: RowEntry): string | undefined {
  switch (entry.type) {
    case "needs":
      return entry.item.decision.task;
    case "captain":
      return entry.item.task;
    default:
      return entry.item.task.id;
  }
}

/** Every row of every section that stands for a task, whichever sections are on: for what each task is doing now. */
export function allTaskRows(sections: HomeSections): RowEntry[] {
  return SECTION_ORDER.flatMap((s) => rowsOf(sections, s));
}

/** The relation of every row that has a task, by row key. */
export function relationsOf(
  entries: readonly Entry[],
  tasks: ReadonlyMap<string, TaskSummary>,
): Map<string, Relation> {
  const out = new Map<string, Relation>();
  const waiters = waitersOf([...tasks.values()]);
  for (const entry of entries) {
    if (entry.type === "header" || entry.type === "more") continue;
    const id = taskIdOf(entry);
    const task = id === undefined ? undefined : tasks.get(id);
    if (id === undefined || task === undefined) continue;
    const parent = partOf(task);
    out.set(entry.key, {
      task: id,
      parent: parent === id ? undefined : parent,
      done: task.children?.done ?? 0,
      total: task.children?.total ?? 0,
      waitsOn: task.waitingOn,
      blocks: waiters.get(id) ?? [],
      followUpOf: task.links.find((l) => l.type === "follow-up")?.task,
    });
  }
  return out;
}

// The tree: the same rows, nested under their parent task -------------------------

/** Where a row stands in the tree. */
export interface TreeInfo {
  depth: number;
  hasChildren: boolean;
  /** Its children are shown. */
  open: boolean;
  /** Shown for context only: it fails the filters, a row below it passes. */
  dim: boolean;
}

/**
 * The rows that stand for tasks, in the order of the sections, the toggled ones only while on.
 * Background work repeats a task; the captain's log is not one.
 */
function taskRows(sections: HomeSections, opened: ReadonlySet<SectionId>): RowEntry[] {
  return SECTION_ORDER.filter(
    (s) => s !== "captain" && (!COLLAPSED_BY_DEFAULT.has(s) || opened.has(s)),
  ).flatMap((s) => rowsOf(sections, s).filter((r) => r.type !== "background"));
}

/**
 * The board as a tree. `all` holds every row with no filter, `shown` the rows that pass the filters. A
 * task goes under its parent task when that is a row too, at any depth; the rest stand at the top
 * in the order of the sections. A row that fails the filters stays, dimmed, while one below it
 * passes. A second decision of one task goes under it. Children follow their ids.
 */
export function buildTree(
  all: HomeSections,
  shown: HomeSections,
  tasks: ReadonlyMap<string, TaskSummary>,
  collapsed: ReadonlySet<string>,
  opened: ReadonlySet<SectionId>,
): { entries: RowEntry[]; info: Map<string, TreeInfo> } {
  const rows = taskRows(all, opened);
  const passes = new Set(taskRows(shown, opened).map((r) => r.key));
  const first = new Map<string, RowEntry>();
  for (const row of rows) {
    const id = taskIdOf(row);
    if (id !== undefined && !first.has(id)) first.set(id, row);
  }
  const parentOf = (row: RowEntry): RowEntry | undefined => {
    const id = taskIdOf(row);
    if (id === undefined) return undefined;
    const own = first.get(id);
    if (own !== row) return own;
    const task = tasks.get(id);
    const parent = task === undefined ? undefined : partOf(task);
    return parent === undefined || parent === id ? undefined : first.get(parent);
  };
  const kids = new Map<string, RowEntry[]>();
  const roots: RowEntry[] = [];
  for (const row of rows) {
    const parent = parentOf(row);
    if (parent === undefined) roots.push(row);
    else kids.set(parent.key, [...(kids.get(parent.key) ?? []), row]);
  }
  const byId = (a: RowEntry, b: RowEntry) => compareTaskIds(taskIdOf(a) ?? "", taskIdOf(b) ?? "");

  /** Whether the row or a row below it passes the filters. `trail` stops a loop of parents. */
  const keep = (row: RowEntry, trail: ReadonlySet<string>): boolean =>
    passes.has(row.key) ||
    (kids.get(row.key) ?? []).some((k) => !trail.has(k.key) && keep(k, new Set(trail).add(row.key)));

  const entries: RowEntry[] = [];
  const info = new Map<string, TreeInfo>();
  const seen = new Set<string>();
  const walk = (row: RowEntry, depth: number) => {
    if (seen.has(row.key) || !keep(row, new Set([row.key]))) return;
    seen.add(row.key);
    const children = (kids.get(row.key) ?? [])
      .toSorted(byId)
      .filter((k) => !seen.has(k.key) && keep(k, new Set([row.key, k.key])));
    const id = taskIdOf(row);
    const open = id === undefined || !collapsed.has(id);
    entries.push(row);
    info.set(row.key, { depth, hasChildren: children.length > 0, open, dim: !passes.has(row.key) });
    if (open) for (const child of children) walk(child, depth + 1);
  };
  // A loop of parents has no root: its rows stand at the top rather than vanish.
  const reached = new Set<string>();
  const flood = (row: RowEntry) => {
    if (reached.has(row.key)) return;
    reached.add(row.key);
    for (const k of kids.get(row.key) ?? []) flood(k);
  };
  for (const root of roots) flood(root);
  for (const row of [...roots, ...rows.filter((r) => !reached.has(r.key))]) walk(row, 0);
  return { entries, info };
}
