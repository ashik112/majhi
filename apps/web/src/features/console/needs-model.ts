import {
  buildQueue,
  type DecisionGroup,
  type Notice,
  type OrgView,
  type OwnerDecision,
  PRIVATE,
  parseDecisionId,
  type QueueGroup,
  type TaskSummary,
  taskNameOf,
} from "@majhi/shared";
import { openLabel, primaryOption } from "@/features/decisions/model";
import type { Lamp } from "./model";
import { blockersOf, projectOf, workspaceName } from "./model";

/** One line of Needs you, whatever it stands for: a decision, several that repeat, or a thing the captain did. */
export interface NeedsRow {
  id: string;
  group: QueueGroup;
  lamp: Lamp;
  incident: boolean;
  org: string | undefined;
  /** The project, or the workspace's name when there is none, before the name. */
  prefix: string | undefined;
  name: string;
  /** One line under the name: why it is here. */
  gist: string;
  /** More than one when the row merges repeats. */
  count: number;
  at: string;
  /** What the row answers. Empty for the captain's done items. */
  decisions: readonly OwnerDecision[];
  /** What the repeats are, when the row merges them. */
  list: string | undefined;
  /** The label of the row's main button, for the quiet button on hover. */
  quick: string;
  /** The captain's done item. */
  notice: Notice | undefined;
}

export type Needs = Record<QueueGroup, NeedsRow[]>;

/** The words after the first "@agent asks:" style lead, or the whole line when it has none. */
function afterLead(decision: Pick<OwnerDecision, "kind" | "title">): string {
  const leads: readonly OwnerDecision["kind"][] = ["question", "approval", "secret"];
  if (!leads.includes(decision.kind) || !decision.title.startsWith("@")) return decision.title;
  const at = decision.title.indexOf(": ");
  return at < 0 ? decision.title : decision.title.slice(at + 2);
}

/** What a decision says in one line under its name. */
export function gistOf(decision: OwnerDecision): string {
  if (decision.blocked !== undefined) return decision.blocked;
  if (decision.kind === "ship" || decision.kind === "publish") {
    return decision.suggestion?.reason ?? "Ready for your review";
  }
  return afterLead(decision);
}

function labelOf(task: TaskSummary | undefined, ws: string): { prefix: string; name: string } | undefined {
  return task === undefined ? undefined : { prefix: projectOf(task) || ws, name: taskNameOf(task) };
}

function rowOf(
  group: DecisionGroup,
  decisions: readonly OwnerDecision[],
  at: string,
  id: string,
  ctx: Context,
  key: { kind: "signin" } | { kind: "blocker"; tasks: readonly string[] } | undefined,
): NeedsRow {
  const first = decisions[0] as OwnerDecision;
  const org = first.org ?? (first.task === undefined ? undefined : (ctx.taskOrg(first.task) ?? PRIVATE));
  const ws = workspaceName(ctx.orgs, org);
  const base = { id, group, incident: group === "incident", org, at, decisions, notice: undefined };
  if (key?.kind === "signin") {
    const accounts = decisions.map((d) => {
      const parsed = parseDecisionId(d.id);
      return parsed?.kind === "signin" ? parsed.account : d.id;
    });
    const waits = [...new Set(decisions.flatMap((d) => d.waits ?? []))];
    return {
      ...base,
      lamp: "needs",
      org: undefined,
      prefix: undefined,
      name: `${decisions.length} accounts signed out`,
      gist: "Their agents cannot run",
      count: decisions.length,
      list: [...accounts, ...waits].join(", "),
      quick: "Sign in",
    };
  }
  if (key?.kind === "blocker") {
    const blockers = key.tasks.map((t) => {
      const task = ctx.task(t);
      return task === undefined ? t : `${projectOf(task) || ws} · ${taskNameOf(task)}`;
    });
    const names = decisions.map((d) => {
      const task = d.task === undefined ? undefined : ctx.task(d.task);
      return task === undefined ? (d.taskTitle ?? d.title) : `${projectOf(task) || ws} · ${taskNameOf(task)}`;
    });
    return {
      ...base,
      lamp: "needs",
      prefix: undefined,
      name: `${decisions.length} tasks blocked by ${blockers.length === 1 ? (blockers[0] as string) : `${blockers.length} tasks`}`,
      gist: "Remove the link and they continue",
      count: decisions.length,
      list: names.join(". "),
      quick: `Remove link for all ${decisions.length}`,
    };
  }
  const label = labelOf(first.task === undefined ? undefined : ctx.task(first.task), ws);
  const lamp: Lamp = "needs";
  const quick = primaryOption(first, undefined)?.label ?? openLabel(first.link);
  if (label !== undefined) {
    return {
      ...base,
      lamp,
      prefix: label.prefix,
      name: label.name,
      gist: gistOf(first),
      count: 1,
      list: undefined,
      quick,
    };
  }
  const hasPrefix = org !== undefined;
  return {
    ...base,
    lamp,
    prefix: hasPrefix ? ws : undefined,
    name: first.task !== undefined && first.taskTitle !== undefined ? first.taskTitle : afterLead(first),
    gist: first.task !== undefined && first.taskTitle !== undefined ? gistOf(first) : (first.sentence ?? ""),
    count: 1,
    list: first.waits === undefined || first.waits.length === 0 ? undefined : first.waits.join(", "),
    quick,
  };
}

interface Context {
  orgs: readonly OrgView[] | undefined;
  task: (id: string) => TaskSummary | undefined;
  taskOrg: (id: string) => string | undefined;
}

/** A merged row taken apart: each of its decisions as a row of its own, for "One by one". */
export function splitRow(
  row: NeedsRow,
  input: { tasks: ReadonlyMap<string, TaskSummary>; orgs: readonly OrgView[] | undefined },
): NeedsRow[] {
  const ctx: Context = {
    orgs: input.orgs,
    task: (id) => input.tasks.get(id),
    taskOrg: (id) => input.tasks.get(id)?.org,
  };
  const group = row.group === "captain" ? "decide" : row.group;
  return row.decisions.map((d) => rowOf(group, [d], d.at, d.id, ctx, undefined));
}

/** What the captain did by itself that the owner has not read: a reply it sent to a client, a bug it filed. */
const CAPTAIN_NOTICE_KINDS: ReadonlySet<Notice["kind"]> = new Set(["client-reply", "bug"]);

/**
 * Needs you: the decisions in four groups with repeats merged (`buildQueue`), incidents first, then
 * what waits longest; and what the captain did that is unread. `decisions` is already limited to the
 * workspace filter and leaves out what is snoozed or being answered.
 */
export function buildNeeds(input: {
  decisions: readonly OwnerDecision[];
  notices: readonly Notice[];
  tasks: ReadonlyMap<string, TaskSummary>;
  orgs: readonly OrgView[] | undefined;
}): Needs {
  const ctx: Context = {
    orgs: input.orgs,
    task: (id) => input.tasks.get(id),
    taskOrg: (id) => input.tasks.get(id)?.org,
  };
  const queue = buildQueue(input.decisions, (task) => {
    const t = input.tasks.get(task);
    return t === undefined ? [] : blockersOf(t);
  });
  const needs: Needs = { incident: [], decide: [], review: [], captain: [] };
  for (const group of ["incident", "decide", "review"] as const) {
    needs[group] = queue[group].map((row) => rowOf(group, row.decisions, row.at, row.id, ctx, row.key));
  }
  // The most repeats first among incidents, then oldest first within every group.
  needs.incident.sort((a, b) => b.count - a.count || a.at.localeCompare(b.at));
  for (const notice of input.notices) {
    if (notice.read || !CAPTAIN_NOTICE_KINDS.has(notice.kind)) continue;
    const ws = workspaceName(input.orgs, notice.org);
    needs.captain.push({
      id: `notice:${notice.id}`,
      group: "captain",
      lamp: "done",
      incident: false,
      org: notice.org,
      prefix: notice.org === undefined ? undefined : ws,
      name: notice.subject,
      gist: notice.detail ?? "",
      count: 1,
      at: notice.at,
      decisions: [],
      list: undefined,
      quick: "Read it",
      notice,
    });
  }
  needs.captain.sort((a, b) => b.at.localeCompare(a.at));
  return needs;
}

/** The rows in the order they are shown and selected: group by group, only the groups' shown rows. */
export function visibleRows(
  needs: Needs,
  shown: Readonly<Record<QueueGroup, number>>,
  closed: ReadonlySet<QueueGroup>,
): NeedsRow[] {
  return (["incident", "decide", "review", "captain"] as const).flatMap((group) =>
    closed.has(group) ? [] : needs[group].slice(0, shown[group]),
  );
}
