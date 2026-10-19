import { batchPlan, type DecisionDetail, type TaskSummary } from "@majhi/shared";
import { openLabel, primaryOption } from "@/features/decisions/model";
import { nameOf, projectOf, type WorkState } from "./model";
import type { ActionDef } from "./needs-pane";
import type { NeedsRow } from "./needs-model";
import type { WorkEntry } from "./work-pane";

/** What the actions of a row can do, handed in by the screen so this file stays free of hooks. */
export interface NeedsDeps {
  answerOne: (d: NeedsRow["decisions"][number], option: string, what: string, text?: string) => void;
  answerMany: (decisions: NeedsRow["decisions"], intent: "approve" | "leave", text: string) => void;
  unblock: (decisions: NeedsRow["decisions"], text: string) => void;
  open: (link: NeedsRow["decisions"][number]["link"]) => void;
  read: (row: NeedsRow) => void;
  later: (row: NeedsRow) => void;
  unmerge: (rowId: string) => void;
  reply: (rowId: string, option: string) => void;
}

/** "orders-db · Database CPU", what a toast says an answer was about. */
export function whatOf(row: NeedsRow): string {
  return row.prefix === undefined ? row.name : `${row.prefix} · ${row.name}`;
}

/**
 * The buttons of a Needs you row, the main one first. A decision shows the answers the server gave it
 * (minus any it said cannot be taken now); a decision with none opens what it points at. A row that
 * merges repeats does one thing for all of them, or opens them one by one.
 */
export function needsActions(
  row: NeedsRow,
  detail: DecisionDetail | undefined,
  deps: NeedsDeps,
): ActionDef[] {
  const later: ActionDef = { id: "later", label: "Later", ghost: true, run: () => deps.later(row) };
  if (row.notice !== undefined) {
    return [{ id: "read", label: "Read it", primary: true, run: () => deps.read(row) }];
  }
  const first = row.decisions[0];
  if (first === undefined) return [later];
  const what = whatOf(row);
  if (row.decisions.length > 1) {
    const unmerge: ActionDef = { id: "one-by-one", label: "One by one", run: () => deps.unmerge(row.id) };
    if (first.kind === "sign-in") {
      return [
        { id: "sign-in", label: "Sign in", primary: true, run: () => deps.open(first.link) },
        { id: "accounts", label: "Open accounts", run: () => deps.open({ kind: "account", id: first.id }) },
        later,
      ];
    }
    if (first.kind === "paused") {
      return [
        {
          id: "unblock",
          label: `Remove link for all ${row.decisions.length}`,
          primary: true,
          run: () => deps.unblock(row.decisions, `Unblocked ${row.decisions.length}: ${row.name}`),
        },
        unmerge,
        later,
      ];
    }
    const plan = batchPlan(row.decisions, "approve");
    return [
      ...(plan.ids.length > 0
        ? [
            {
              id: "all",
              label: `Do all ${plan.ids.length}`,
              primary: true,
              run: () => deps.answerMany(row.decisions, "approve", `Did ${plan.ids.length}: ${row.name}`),
            } satisfies ActionDef,
          ]
        : []),
      unmerge,
      later,
    ];
  }
  const blocked = detail?.id === first.id ? detail.blocked : undefined;
  const options = first.options.filter((o) => blocked?.[o.id] === undefined);
  if (options.length === 0) {
    return [
      { id: "open", label: openLabel(first.link), primary: true, run: () => deps.open(first.link) },
      later,
    ];
  }
  const main = primaryOption(first, blocked);
  const buttons: ActionDef[] = options.map((o) => ({
    id: o.id,
    label: o.label,
    primary: o.id === main?.id,
    typed: o.text === true,
    run: () => (o.text === true ? deps.reply(row.id, o.id) : deps.answerOne(first, o.id, what)),
  }));
  const where = first.link.kind === "task" || first.link.kind === "chat";
  return [
    ...buttons,
    ...(where ? [{ id: "open", label: "Open", ghost: true, run: () => deps.open(first.link) } satisfies ActionDef] : []),
    later,
  ];
}

export interface WorkDeps {
  answer: (task: TaskSummary) => void;
  unblock: (task: TaskSummary) => void;
  start: (task: TaskSummary, now: boolean) => void;
  stop: (task: TaskSummary) => void;
  open: (task: TaskSummary) => void;
}

/**
 * The buttons of a Work row: one that fits its state (Answer, Unblock, Resume; Start now and Stop are
 * outlined), then Open. The main one is the only filled button on screen while this pane has the focus.
 */
export function workActions(entry: WorkEntry, deps: WorkDeps): ActionDef[] {
  const { task, state, rail } = entry;
  const open: ActionDef = { id: "open", label: "Open", ghost: true, run: () => deps.open(task) };
  if (rail === "done") return [open];
  if (rail === "ideas") return [{ id: "start", label: "Start", run: () => deps.start(task, false) }, open];
  if (rail === "queued" || state === "queued") {
    return [{ id: "start-now", label: "Start now", run: () => deps.start(task, true) }, open];
  }
  const byState: Record<WorkState, ActionDef | undefined> = {
    "your-call": { id: "answer", label: "Answer", primary: true, run: () => deps.answer(task) },
    blocked: { id: "unblock", label: "Unblock", primary: true, run: () => deps.unblock(task) },
    paused: { id: "resume", label: "Resume", primary: true, run: () => deps.start(task, false) },
    working: { id: "stop", label: "Stop", run: () => deps.stop(task) },
    queued: undefined,
    mr: undefined,
  };
  const main = state === undefined ? undefined : byState[state];
  return main === undefined ? [open] : [main, open];
}

/** The label of a work entry, for a toast: `project · Name`, or the name alone. */
export function workWhat(task: TaskSummary): string {
  const project = projectOf(task);
  return project === "" ? nameOf(task) : `${project} · ${nameOf(task)}`;
}
