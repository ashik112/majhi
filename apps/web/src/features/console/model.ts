import {
  type Conversation,
  lineOrder,
  type OrgView,
  type OwnerDecision,
  PRIVATE,
  PRIVATE_NAME,
  type TaskSummary,
  taskNameOf,
} from "@majhi/shared";
import { isYourTurn } from "../tasks/model";

/** How many workspace hues there are. The sixth is the neutral one, kept for Private. */
const HUES = 6;
const PRIVATE_HUE = HUES - 1;

/**
 * Each workspace's identity hue (0 to 5): its place in the workspace list, so a workspace keeps its
 * color while others come and go after it. Private is always the neutral sixth. A color is never a
 * status color and never the workspace's key.
 */
export function workspaceHues(orgs: readonly OrgView[] | undefined): ReadonlyMap<string, number> {
  const map = new Map<string, number>([[PRIVATE, PRIVATE_HUE]]);
  let next = 0;
  for (const org of orgs ?? []) {
    if (org.id === PRIVATE) continue;
    map.set(org.id, next % PRIVATE_HUE);
    next += 1;
  }
  return map;
}

/** The CSS variable that carries a workspace's hue, for `style={{ "--ws": ... }}`. */
export function wsVar(hues: ReadonlyMap<string, number>, org: string | undefined): string {
  return `var(--c-ws-${hues.get(org ?? PRIVATE) ?? PRIVATE_HUE})`;
}

/** The name a workspace shows: its name, never its key. */
export function workspaceName(orgs: readonly OrgView[] | undefined, org: string | undefined): string {
  if (org === undefined || org === PRIVATE) return PRIVATE_NAME;
  return orgs?.find((o) => o.id === org)?.name ?? org;
}

/** "5m", "3h", "11d": how long ago, for the right edge of a row. */
export function ageWord(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(1, Math.round((now - then) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

// Work -----------------------------------------------------------------------

/** What a task in Work is doing, for its lamp, its word and its main button. */
export type WorkState = "your-call" | "working" | "blocked" | "paused" | "queued" | "mr";

export const WORK_STATE_WORD: Record<WorkState, string> = {
  "your-call": "your call",
  working: "working",
  blocked: "blocked",
  paused: "paused",
  queued: "queued",
  mr: "MR open",
};

export type Lamp = "working" | "needs" | "paused" | "done" | "idle";

export const WORK_STATE_LAMP: Record<WorkState, Lamp> = {
  "your-call": "needs",
  working: "working",
  blocked: "paused",
  paused: "paused",
  queued: "idle",
  mr: "done",
};

/** The quiet tone of a state's word. */
export const WORK_STATE_TONE: Record<WorkState, "needs" | "working" | "paused" | "idle"> = {
  "your-call": "needs",
  working: "working",
  blocked: "paused",
  paused: "paused",
  queued: "idle",
  mr: "idle",
};

/** The order of states inside a project: your call first, blocked last. */
const STATE_RANK: Record<WorkState, number> = {
  "your-call": 0,
  working: 1,
  mr: 2,
  queued: 3,
  paused: 4,
  blocked: 5,
};

/**
 * The state of an open task. It waits for the owner when a decision names it, it asks in its room, it
 * finished, or its agents all ended their turn. Held and waiting tasks are blocked or paused; what has
 * not started is queued. A task that is done or an idea has no state: it lives in a rail.
 */
export function workStateOf(task: TaskSummary, asking: ReadonlySet<string>): WorkState | undefined {
  if (task.idea !== undefined) return undefined;
  switch (task.status) {
    case "done":
      return undefined;
    case "inbox":
    case "ready":
      return "queued";
    case "mr":
      return "mr";
    case "review":
      return "your-call";
    case "paused":
      return task.waitingOn.length > 0 || task.hold !== undefined ? "blocked" : "paused";
    case "running":
      return asking.has(task.id) || task.asking === true || isYourTurn(task) ? "your-call" : "working";
  }
}

/** The ids of tasks a decision names: they wait for the owner, whatever their status says. */
export function askingTasks(decisions: readonly OwnerDecision[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const d of decisions) if (d.task !== undefined) ids.add(d.task);
  return ids;
}

export interface WorkRow {
  task: TaskSummary;
  state: WorkState;
}

export interface ProjectGroup {
  /** The first project, or empty for a workspace's tasks with none. */
  project: string;
  rows: WorkRow[];
  /** Blocked rows folded under one line when a project has two or more. */
  folded: WorkRow[];
}

export interface WorkspaceGroup {
  org: string;
  projects: ProjectGroup[];
  counts: Record<WorkState, number>;
}

function emptyCounts(): Record<WorkState, number> {
  return { "your-call": 0, working: 0, blocked: 0, paused: 0, queued: 0, mr: 0 };
}

/** The project a task shows under: its first, or none. */
export function projectOf(task: Pick<TaskSummary, "repos">): string {
  return task.repos[0]?.project ?? "";
}

/**
 * Work, grouped by workspace and then project. Queued tasks wait in the Up next rail, not here. Within a
 * project: your call, working, MR open, paused, blocked, each newest first. Two or more blocked tasks of
 * a project fold into one line.
 */
export function buildWork(
  tasks: readonly TaskSummary[],
  asking: ReadonlySet<string>,
  org: string | undefined,
  orgOrder: readonly string[],
): WorkspaceGroup[] {
  const byOrg = new Map<string, WorkRow[]>();
  for (const task of tasks) {
    if (task.chat === true || task.lane === true) continue;
    if (org !== undefined && (task.org ?? PRIVATE) !== org) continue;
    const state = workStateOf(task, asking);
    if (state === undefined || state === "queued") continue;
    const key = task.org ?? PRIVATE;
    const list = byOrg.get(key) ?? [];
    list.push({ task, state });
    byOrg.set(key, list);
  }
  const order = (a: string, b: string) => {
    const at = orgOrder.indexOf(a);
    const bt = orgOrder.indexOf(b);
    return (at < 0 ? orgOrder.length : at) - (bt < 0 ? orgOrder.length : bt) || a.localeCompare(b);
  };
  return [...byOrg.keys()].sort(order).map((key) => {
    const rows = byOrg.get(key) ?? [];
    const counts = emptyCounts();
    for (const r of rows) counts[r.state] += 1;
    const byProject = new Map<string, WorkRow[]>();
    for (const r of rows) {
      const p = projectOf(r.task);
      byProject.set(p, [...(byProject.get(p) ?? []), r]);
    }
    const projects = [...byProject.entries()]
      .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
      .map(([project, list]): ProjectGroup => {
        const sorted = list.toSorted(
          (a, b) =>
            STATE_RANK[a.state] - STATE_RANK[b.state] || b.task.updatedAt.localeCompare(a.task.updatedAt),
        );
        const blocked = sorted.filter((r) => r.state === "blocked");
        const fold = blocked.length >= 2;
        return {
          project,
          rows: fold ? sorted.filter((r) => r.state !== "blocked") : sorted,
          folded: fold ? blocked : [],
        };
      });
    return { org: key, projects, counts };
  });
}

/** The words after a workspace head: "3 your call · 2 blocked". */
export function workspaceMeta(counts: Record<WorkState, number>): string {
  const parts: [WorkState, string][] = [
    ["your-call", "your call"],
    ["working", "working"],
    ["queued", "queued"],
    ["blocked", "blocked"],
  ];
  return parts
    .filter(([state]) => counts[state] > 0)
    .map(([state, word]) => `${counts[state]} ${word}`)
    .join(" · ");
}

export interface Rails {
  queued: TaskSummary[];
  ideas: TaskSummary[];
  doneToday: TaskSummary[];
}

/** Up next (in the order the line starts), Ideas, and what finished since midnight, newest first. */
export function buildRails(tasks: readonly TaskSummary[], org: string | undefined, now: number): Rails {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const since = startOfDay.toISOString();
  const rails: Rails = { queued: [], ideas: [], doneToday: [] };
  for (const task of tasks) {
    if (task.chat === true || task.lane === true) continue;
    if (org !== undefined && (task.org ?? PRIVATE) !== org) continue;
    if (task.idea !== undefined) {
      if (task.status !== "done") rails.ideas.push(task);
    } else if (task.status === "inbox" || task.status === "ready") rails.queued.push(task);
    else if (task.status === "done" && task.updatedAt >= since) rails.doneToday.push(task);
  }
  rails.queued = lineOrder(rails.queued);
  rails.ideas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  rails.doneToday.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return rails;
}

/**
 * The tasks that hold a task back for good: the ones its `depends-on` links name, when it is paused
 * as blocked, and what it still waits on. A target that was closed without merging is not in
 * `waitingOn` (it will never be met), but it is why the task is stuck.
 */
export function blockersOf(
  task: Pick<TaskSummary, "pausedReason" | "links" | "waitingOn" | "status">,
): readonly string[] {
  if (task.status !== "paused" || task.pausedReason !== "blocked") return task.waitingOn;
  const linked = task.links.filter((l) => l.type === "depends-on").map((l) => l.task);
  return [...new Set([...linked, ...task.waitingOn])];
}

/** The task's own name, as it shows after the project. */
export function nameOf(task: TaskSummary): string {
  return taskNameOf(task);
}

// Chat -----------------------------------------------------------------------

export interface ChatChip {
  /** The conversation id, or `captain` for the owner's own captain chat. */
  id: string;
  kind: "captain" | "task" | "conversation";
  title: string;
  org: string | undefined;
  unread: number;
}

/** The workspace of a conversation. A captain thread of a workspace belongs to it. */
export function conversationOrg(c: Conversation): string {
  return c.org ?? PRIVATE;
}

/**
 * The chats under the chips: the owner's captain first, then the selected task's room, then the other
 * conversations of the workspace filter, unread first and newest next. The owner's captain chat is the
 * root agent chat of the captain; it is never listed twice.
 */
export function buildChips(input: {
  conversations: readonly Conversation[];
  captainAgent: string | undefined;
  selectedTask: { id: string; title: string; org: string | undefined } | undefined;
  org: string | undefined;
}): ChatChip[] {
  const chips: ChatChip[] = [{ id: "captain", kind: "captain", title: "Captain", org: undefined, unread: 0 }];
  const taken = new Set<string>(["captain"]);
  if (input.selectedTask !== undefined) {
    const own = input.conversations.find((c) => c.id === input.selectedTask?.id);
    chips.push({
      id: input.selectedTask.id,
      kind: "task",
      title: input.selectedTask.title,
      org: input.selectedTask.org,
      unread: own?.unread ?? 0,
    });
    taken.add(input.selectedTask.id);
  }
  const rest = input.conversations
    .filter((c) => {
      if (c.archived === true || taken.has(c.id) || c.kind === "task") return false;
      const rootCaptain = c.kind === "agent" && c.org === undefined && c.agent === input.captainAgent;
      if (rootCaptain) {
        if (c.current === true) chips[0] = { ...(chips[0] as ChatChip), unread: c.unread };
        return false;
      }
      return input.org === undefined || conversationOrg(c) === input.org;
    })
    .toSorted((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || b.lastAt.localeCompare(a.lastAt));
  for (const c of rest) {
    chips.push({ id: c.id, kind: "conversation", title: c.title, org: c.org, unread: c.unread });
  }
  return chips;
}
