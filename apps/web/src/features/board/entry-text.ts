import type { DeployStepView, HomeDeploy, TaskSummary } from "@majhi/shared";
import type { LampState } from "@/components/ui/lamp";
import { rowTitle } from "../decisions/model";
import { openDue, shortAgo } from "../tasks/schedule";
import { backgroundLine, checkElapsed, checkLine, checkState, duration } from "./check-state";
import {
  blockerText,
  decisionTitle,
  type NeedsItem,
  type QueuedItem,
  type RowEntry,
  SECTION_WORD,
  type ShippingItem,
} from "./home-model";
import { plainTitle } from "./model";

/**
 * What a row of the board says, in one place, so the card and the tree row cannot say different
 * things about one task. Pure: the screen reads the queries and hands them in.
 */

/** The color of a status line: a lamp state, or `ok` for a green check. */
export type LineTone = LampState | "ok";

export interface EntryLine {
  /** The lamp of the row. */
  lamp: LampState;
  /** The word of its section: Needs you, Running, Waiting. */
  word: string;
  /** The one status line. Empty when something else says it (a "Waits on" chip). */
  text: string;
  /** The same for a card, when the card shows more beside it and the line need not repeat it. */
  cardText?: string;
  tone: LineTone | undefined;
  /** A second sentence: why it is held, what its limit says. */
  why: string | undefined;
  /** Hover text of the status line. */
  hover: string | undefined;
  /** How long: the wait, the run, the age. */
  age: string;
  /** The agent that holds it, for the card's foot. */
  agent: string | undefined;
  /** For a first action that waits (a check that runs): the time it has run. */
  elapsed: string;
  title: string;
  /** The task's own id, when the row has a task. */
  id: string | undefined;
}

export interface LineContext {
  now: number;
  /** A workspace's name from its id. */
  orgName: (id: string) => string;
  /** The subtasks of each parent. */
  kids: ReadonlyMap<string, readonly TaskSummary[]>;
  /** Every task, for what a decision's task says about itself (its hold). */
  tasks: ReadonlyMap<string, TaskSummary>;
}

const CI_WORDS = {
  failing: "CI failed",
  pending: "CI running",
  passing: "CI passed",
  none: "No CI",
} as const;

/** How long background work has run: seconds in the first minute, so a fresh check does not read "now". */
function runFor(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  return ms >= 0 && ms < 60_000 ? duration(ms) : shortAgo(iso, now);
}

const agentOf = (task: TaskSummary, doing?: string): string | undefined =>
  doing ?? task.working[0] ?? task.team[0];

function needsLine(
  item: NeedsItem,
  ctx: LineContext,
): Pick<EntryLine, "text" | "tone" | "hover"> & { why?: string } {
  const d = item.decision;
  const check = item.check;
  if (d.kind === "ship") {
    if (check !== undefined) {
      const state = checkState(check);
      return {
        text: checkLine(check, ctx.now),
        tone:
          state.kind === "ok"
            ? "ok"
            : state.kind === "running" || state.kind === "queued"
              ? "working"
              : "needs",
        hover: check.outcome,
      };
    }
    return d.blocked === undefined
      ? { text: "Ready to ship", tone: undefined, hover: undefined }
      : { text: d.blocked, tone: "needs", hover: undefined };
  }
  if (d.kind === "question" || d.kind === "approval")
    return { text: rowTitle(d), tone: "needs", hover: undefined };
  // A paused task says its hold, as the model states it, rather than the card's own words.
  const hold = d.kind === "paused" && d.task !== undefined ? ctx.tasks.get(d.task)?.hold : undefined;
  if (hold !== undefined)
    return { text: `Held: ${hold.label}`, why: hold.sentence, tone: "needs", hover: undefined };
  return { text: d.blocked ?? d.sentence ?? d.title, tone: "needs", hover: undefined };
}

const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** The step of a task's deploys the owner reads first: what failed, what waits for them, what moves, what is next. */
function leadStep(steps: readonly DeployStepView[]): DeployStepView | undefined {
  const order: DeployStepView["state"][][] = [
    ["failed", "rolled-back"],
    ["waits-for-owner"],
    ["running", "verifying", "queued"],
    ["captain-next"],
    ["blocked"],
    ["waits-for-previous"],
  ];
  for (const states of order) {
    const found = steps.find((s) => states.includes(s.state));
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The status line of merged work that is being deployed. */
export function deployLine(deploy: HomeDeploy): Pick<EntryLine, "lamp" | "text" | "tone"> {
  const step = leadStep(deploy.steps);
  if (step === undefined) return { lamp: "done", text: "Live", tone: "ok" };
  switch (step.state) {
    case "failed":
      return { lamp: "needs", text: `${capital(step.env)} deploy failed`, tone: "needs" };
    case "rolled-back":
      return { lamp: "needs", text: `${capital(step.env)} deploy failed, rolled back`, tone: "needs" };
    case "waits-for-owner":
      return { lamp: "needs", text: `${capital(step.env)} deploy waits for you`, tone: "needs" };
    case "verifying":
      return { lamp: "working", text: `Checking ${step.env}`, tone: "working" };
    case "running":
    case "queued":
      return { lamp: "working", text: `Deploying to ${step.env}`, tone: "working" };
    case "captain-next":
      return { lamp: "idle", text: `Deploys to ${step.env} next`, tone: undefined };
    case "blocked":
      return { lamp: "paused", text: `${capital(step.env)}: ${step.why ?? "blocked"}`, tone: "paused" };
    default:
      return { lamp: "idle", text: `${capital(step.env)} waits for the one before`, tone: undefined };
  }
}

function shippingLine(item: ShippingItem): Pick<EntryLine, "lamp" | "text" | "cardText" | "tone"> {
  const { task, mr, extra } = item;
  if (item.deploy !== undefined) {
    const line = deployLine(item.deploy);
    return { ...line, cardText: line.text };
  }
  const ci = mr?.ci;
  const lamp: LampState =
    ci === "failing" ? "needs" : ci === "pending" ? "working" : ci === "passing" ? "done" : "idle";
  const who =
    ci === "failing"
      ? ""
      : task.autonomous === true
        ? ci === "passing"
          ? " · the captain merges it"
          : " · the captain merges when green"
        : ci === "passing"
          ? " · ready for you to merge"
          : "";
  const text =
    mr === undefined
      ? "Merge request open"
      : `!${mr.number} ${mr.project}${extra > 0 ? ` +${extra}` : ""} · ${CI_WORDS[mr.ci]}${who}`;
  // The card's trail chip already names the merge request and its CI: the line says who acts.
  const cardText =
    ci === "failing"
      ? "Fix the failing checks"
      : task.autonomous === true
        ? ci === "passing"
          ? "The captain merges it"
          : "The captain merges when green"
        : ci === "passing"
          ? "Ready for you to merge"
          : "Waiting for CI";
  return { lamp, text, cardText, tone: lamp };
}

function queuedText(item: QueuedItem, ctx: LineContext): string {
  const { task, blocker } = item;
  if (task.status === "review") return "Finished, nothing waits on you. Mark it done or reply";
  if (task.status === "running" || task.status === "paused")
    return task.children === undefined
      ? "No agent is working on it"
      : `Waits on its subtasks (${task.children.done} of ${task.children.total} done)`;
  return blockerText(blocker, ctx.orgName);
}

/** The line of every kind of row. */
export function lineOf(entry: RowEntry, ctx: LineContext): EntryLine {
  const base = { why: undefined, hover: undefined, elapsed: "", agent: undefined, id: undefined };
  const word = SECTION_WORD[entry.section];
  switch (entry.type) {
    case "needs": {
      const d = entry.item.decision;
      const line = needsLine(entry.item, ctx);
      const task = d.task;
      return {
        ...base,
        ...line,
        lamp: d.kind === "paused" ? "paused" : "needs",
        word,
        age: shortAgo(d.at, ctx.now),
        elapsed: entry.item.check === undefined ? "" : checkElapsed(entry.item.check, ctx.now),
        title: task === undefined ? d.title : decisionTitle(d),
        id: d.chat === true ? undefined : task,
      };
    }
    case "held": {
      const t = entry.item.task;
      const deploy = entry.item.deploy === undefined ? undefined : deployLine(entry.item.deploy);
      return {
        ...base,
        lamp: "needs",
        word,
        text: deploy?.text ?? `Held: ${t.hold?.label ?? "paused"}`,
        tone: "needs",
        why: deploy === undefined ? t.hold?.sentence : undefined,
        age: shortAgo(t.updatedAt, ctx.now),
        agent: agentOf(t),
        title: plainTitle(t.title),
        id: t.id,
      };
    }
    case "running": {
      const { task, doing } = entry.item;
      const kids = ctx.kids.get(task.id) ?? [];
      const running = kids.filter((k) => k.status === "running").length;
      const text =
        doing?.text ??
        (task.working.length === 0 && task.children !== undefined
          ? `${running} of ${task.children.total} subtasks running`
          : "Working");
      return {
        ...base,
        lamp: "working",
        word,
        text,
        tone: "working",
        age: shortAgo(doing?.since ?? task.updatedAt, ctx.now),
        agent: agentOf(task, doing?.agent),
        title: plainTitle(task.title),
        id: task.id,
      };
    }
    case "background": {
      const { task, work } = entry.item;
      const queued = work.kind === "queued-check";
      return {
        ...base,
        lamp: queued ? "idle" : "working",
        word,
        text: backgroundLine(work),
        tone: queued ? undefined : "working",
        age: runFor(work.since, ctx.now),
        agent: agentOf(task),
        title: plainTitle(task.title),
        id: task.id,
      };
    }
    case "waiting": {
      const t = entry.item.task;
      const hold = t.hold;
      const waitsOnTasks = t.waitingOn.length > 0 && hold === undefined;
      return {
        ...base,
        lamp: hold === undefined ? "idle" : "paused",
        word,
        text:
          hold !== undefined
            ? `Held: ${hold.label}`
            : waitsOnTasks
              ? ""
              : t.children === undefined
                ? "Waiting"
                : `Waiting on its subtasks, ${t.children.done} of ${t.children.total} done`,
        tone: hold === undefined ? undefined : "paused",
        why: hold?.sentence,
        age: shortAgo(t.updatedAt, ctx.now),
        agent: agentOf(t),
        title: plainTitle(t.title),
        id: t.id,
      };
    }
    case "shipping": {
      const t = entry.item.task;
      const line = shippingLine(entry.item);
      return {
        ...base,
        ...line,
        word,
        age: shortAgo(t.updatedAt, ctx.now),
        agent: agentOf(t),
        title: plainTitle(t.title),
        id: t.id,
      };
    }
    case "next":
    case "triage": {
      const t = entry.item.task;
      return {
        ...base,
        lamp: "idle",
        word,
        text: queuedText(entry.item, ctx),
        tone: undefined,
        age: shortAgo(t.updatedAt, ctx.now),
        agent: agentOf(t),
        title: plainTitle(t.title),
        id: t.id,
      };
    }
    case "captain":
      return {
        ...base,
        lamp: "done",
        word,
        text: entry.item.evidence ?? entry.item.reason,
        tone: undefined,
        age: shortAgo(entry.item.at, ctx.now),
        title: entry.item.text,
        id: entry.item.task,
      };
    case "done": {
      const t = entry.item.task;
      return {
        ...base,
        lamp: "done",
        word,
        text: entry.item.undoId === undefined ? "" : "Merged by the captain",
        tone: undefined,
        age: new Date(t.updatedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
        agent: agentOf(t),
        title: plainTitle(t.title),
        id: t.id,
      };
    }
  }
}

/** The priority and due of a queued row, shown before its line. */
export function queuedMarks(task: TaskSummary, now: number) {
  return {
    priority: task.priority !== undefined && task.priority !== "normal" ? task.priority : undefined,
    due: openDue(task, now),
  };
}

/** What another task is doing now, in a word, for the chip of a task that waits on it. */
export interface LiveState {
  lamp: LampState;
  word: string;
}

/**
 * The live state of every task the board draws, by id: a running task says what it does, any other
 * says its column. `sections` is the board with no filter, so a chip can name a task the filters hide.
 */
export function liveStates(rows: readonly RowEntry[], ctx: LineContext): Map<string, LiveState> {
  const out = new Map<string, LiveState>();
  for (const entry of rows) {
    if (entry.type === "background" || entry.type === "captain") continue;
    const line = lineOf(entry, ctx);
    if (line.id === undefined || out.has(line.id)) continue;
    out.set(line.id, {
      lamp: line.lamp,
      word: entry.type === "running" ? line.text : SECTION_WORD[entry.section].toLowerCase(),
    });
  }
  return out;
}
