import {
  type BoardCounts,
  type CaptainAction,
  type CiState,
  lifecycle,
  type OwnerDecision,
  PRIVATE,
  type TaskPriority,
  type TaskSummary,
} from "@majhi/shared";
import { primaryOption, rowTitle, workspaceOf } from "../decisions/model";
import type { BannerAction } from "../shell/model";
import { plainTitle, waitsOnSubtasks } from "./model";

type Blocker = lifecycle.Blocker;

/**
 * Home, sorted by who holds the ball. Pure: the screen reads the queries and hands them here, so the
 * assignment of every task to one section, the order inside a section and the one verb of each row
 * are decided in one place and can be checked without a browser.
 */

export type SectionId = "needs" | "running" | "shipping" | "next" | "triage" | "captain" | "done";

export const SECTION_ORDER: readonly SectionId[] = [
  "needs",
  "running",
  "shipping",
  "next",
  "triage",
  "captain",
  "done",
];

export const SECTION_LABEL: Record<SectionId, string> = {
  needs: "Needs you",
  running: "Running now",
  shipping: "Shipping",
  next: "Up next",
  triage: "To triage",
  captain: "Captain handled",
  done: "Done today",
};

/** What each section's order is, said at the right of its header. */
export const SECTION_SORT: Record<SectionId, string> = {
  needs: "blocks others, priority, waited",
  running: "longest running",
  shipping: "failed first, then running",
  next: "can start, priority, due, age",
  triage: "oldest first",
  captain: "newest first",
  done: "newest first",
};

/** Sections that stay shut until the owner opens them. */
export const COLLAPSED_BY_DEFAULT: ReadonlySet<SectionId> = new Set(["triage", "captain", "done"]);

/** How many rows a long section shows before "+n more". Needs you and Running now always show all. */
export const SECTION_CAP: Partial<Record<SectionId, number>> = { shipping: 10, next: 5 };

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
  captain: readonly CaptainAction[];
  /** Captain actions that merged a task and can be undone, by task. */
  undoOf: ReadonlyMap<string, number>;
  org: string | undefined;
  query: string;
  now: number;
}

// Section of a task ---------------------------------------------------------

export type TaskSection = Exclude<SectionId, "captain">;

/**
 * The one section a task belongs to, or undefined when Home does not draw it (a quiet chat). A task
 * a decision waits on is Needs you, whatever its status. Done tasks are Done today; the screen keeps
 * only today's.
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
      return ctx.working.has(task.id) ? "running" : "next";
    case "paused":
      return waitsOnSubtasks(task) ? "next" : "running";
    case "review":
      return "next";
    case "ready":
      return "next";
    case "inbox":
      return lifecycle.isUntriaged(task) ? "triage" : "next";
  }
}

// Rows ----------------------------------------------------------------------

export interface NeedsItem {
  decision: OwnerDecision;
  /** How many open tasks wait for this decision's task. */
  blocks: number;
}
export interface RunningItem {
  task: TaskSummary;
  doing: DoingFact | undefined;
  /** Paused with no decision for the owner: the captain, Auto-pilot or a budget stopped it. */
  paused: boolean;
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
  running: RunningItem[];
  shipping: ShippingItem[];
  next: QueuedItem[];
  triage: QueuedItem[];
  captain: CaptainAction[];
  done: DoneItem[];
}

/** What the strip says: counts of the workspace filter, before the text filter narrows the rows. */
export type HomeTotals = Record<SectionId, number> & { working: number };

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };
const priorityRank = (p: TaskPriority | undefined) => PRIORITY_RANK[p ?? "normal"];

/** Tasks that wait for this task to finish: the number "blocks others" sorts by. */
export function blockedBy(tasks: readonly TaskSummary[]): Map<string, number> {
  const by = new Map<string, number>();
  for (const t of tasks) {
    if (t.status === "done") continue;
    for (const dep of t.waitingOn) by.set(dep, (by.get(dep) ?? 0) + 1);
  }
  return by;
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

/** Rows of Running now: longest running first (the turn's start, else the last change), paused ones last. */
function runningOrder(a: RunningItem, b: RunningItem): number {
  const since = (r: RunningItem) => r.doing?.since ?? r.task.updatedAt;
  return (
    Number(a.paused) - Number(b.paused) ||
    since(a).localeCompare(since(b)) ||
    a.task.id.localeCompare(b.task.id)
  );
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

/** Rank of a queued row: tasks that can start, then a task with no agent on it (running or paused), last. */
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

/** Every section of Home, each task in exactly one, ordered, with the workspace and text filters applied. */
export function buildHome(input: HomeInput): { sections: HomeSections; totals: HomeTotals } {
  const { org, query, now } = input;
  const inScope = (t: TaskSummary) => org === undefined || (t.org ?? PRIVATE) === org;
  const tasks = input.tasks.filter(inScope);
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const decisions = input.decisions.filter((d) => org === undefined || workspaceOf(d) === org);
  const asking = new Set(input.decisions.flatMap((d) => (d.task === undefined ? [] : [d.task])));
  const blocks = blockedBy(input.tasks);
  const midnight = localMidnight(now);

  const needs: NeedsItem[] = decisions.map((decision) => ({
    decision,
    blocks: decision.task === undefined ? 0 : (blocks.get(decision.task) ?? 0),
  }));
  needs.sort((a, b) =>
    needsOrder(a, b, (id) => priorityRank(id === undefined ? undefined : byId.get(id)?.priority)),
  );

  const running: RunningItem[] = [];
  const shipping: ShippingItem[] = [];
  const next: QueuedItem[] = [];
  const triage: QueuedItem[] = [];
  const done: DoneItem[] = [];
  for (const task of tasks) {
    const section = sectionOf(task, { asking, working: input.working });
    const blocker = input.blockers.get(task.id);
    switch (section) {
      case "running":
        running.push({ task, doing: input.doing.get(task.id), paused: task.status === "paused" });
        break;
      case "shipping":
        shipping.push({ task, mr: input.mrs.get(task.id), extra: input.mrExtra.get(task.id) ?? 0 });
        break;
      case "next":
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
  running.sort(runningOrder);
  shipping.sort(shippingOrder);
  next.sort(queuedOrder);
  triage.sort(
    (a, b) => a.task.updatedAt.localeCompare(b.task.updatedAt) || a.task.id.localeCompare(b.task.id),
  );
  done.sort((a, b) => newestFirst(a.task, b.task));

  const captain = input.captain
    .filter(
      (a) =>
        a.outcome === "done" &&
        a.undo !== "done" &&
        now - Date.parse(a.at) < CAPTAIN_WINDOW_MS &&
        (org === undefined || a.org === org),
    )
    .toSorted((a, b) => b.at.localeCompare(a.at) || b.id - a.id);

  const totals: HomeTotals = {
    needs: needs.length,
    running: running.length,
    shipping: shipping.length,
    next: next.length,
    triage: triage.length,
    captain: captain.length,
    done: done.length,
    working: running.filter((r) => !r.paused).length,
  };

  const sections: HomeSections = {
    needs: needs.filter((n) =>
      matches(query, n.decision.task, decisionTitle(n.decision), n.decision.sentence),
    ),
    running: running.filter((r) => matches(query, r.task.id, r.task.title)),
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
): ActionSpec[] {
  const ship = decision.kind === "ship";
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
  }
}

export function runningActions(item: RunningItem): ActionSpec[] {
  const id = item.task.id;
  return item.paused
    ? [{ kind: "start", task: id, label: "Resume" }, open(id, "Open")]
    : [open(id, "Watch"), { kind: "stop", task: id, label: "Stop" }];
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
  /** Sections the owner opened (the collapsed ones). */
  opened: ReadonlySet<SectionId>;
  /** Sections whose "+n more" was opened. */
  all: ReadonlySet<SectionId>;
}

export type Entry =
  | {
      type: "header";
      key: string;
      section: SectionId;
      count: number;
      collapsible: boolean;
      open: boolean;
      extra?: string;
    }
  | { type: "needs"; key: string; section: "needs"; item: NeedsItem }
  | { type: "running"; key: string; section: "running"; item: RunningItem }
  | { type: "shipping"; key: string; section: "shipping"; item: ShippingItem }
  | { type: "next"; key: string; section: "next"; item: QueuedItem }
  | { type: "triage"; key: string; section: "triage"; item: QueuedItem }
  | { type: "captain"; key: string; section: "captain"; item: CaptainAction }
  | { type: "done"; key: string; section: "done"; item: DoneItem }
  | { type: "more"; key: string; section: SectionId; hidden: number };

export type RowEntry = Exclude<Entry, { type: "header" | "more" }>;

/** Whether a key can land on the entry: rows, "+n more" and the header of a section that can open. */
export function focusable(entry: Entry): boolean {
  return entry.type === "header" ? entry.collapsible : true;
}

export function headerKey(section: SectionId): string {
  return `h:${section}`;
}

/** Sections with nothing in them are not drawn at all. */
export function buildEntries(sections: HomeSections, view: ListView): Entry[] {
  const out: Entry[] = [];
  for (const section of SECTION_ORDER) {
    const count = sections[section].length;
    if (count === 0) continue;
    const collapsible = COLLAPSED_BY_DEFAULT.has(section);
    const open = !collapsible || view.opened.has(section);
    const paused = section === "running" ? sections.running.filter((r) => r.paused).length : 0;
    out.push({
      type: "header",
      key: headerKey(section),
      section,
      count,
      collapsible,
      open,
      ...(paused > 0 ? { extra: `${paused} paused` } : {}),
    });
    if (!open) continue;
    const cap = SECTION_CAP[section];
    const limit = cap === undefined || view.all.has(section) ? count : cap;
    const rows = rowsOf(sections, section).slice(0, limit);
    out.push(...rows);
    if (count > limit) out.push({ type: "more", key: `m:${section}`, section, hidden: count - limit });
  }
  return out;
}

function rowsOf(sections: HomeSections, section: SectionId): RowEntry[] {
  switch (section) {
    case "needs":
      return sections.needs.map((item) => ({ type: "needs", key: `d:${item.decision.id}`, section, item }));
    case "running":
      return sections.running.map((item) => ({ type: "running", key: `t:${item.task.id}`, section, item }));
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
      return needsActions(entry.item.decision, blockedOf(entry.item.decision.id));
    case "running":
      return runningActions(entry.item);
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
