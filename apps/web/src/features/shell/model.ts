import type { AccountView, OrgView, PendingNotice, TaskSummary } from "@majhi/shared";
import type { AgentInfo } from "../../lib/agent-index";
import { badgeLetters, formatAgo } from "../../lib/format";
import { PAGE_PATH, type PagePath } from "../../lib/pages";
import { resetLabel } from "../accounts/model";

// Organisations -------------------------------------------------------------

export const ALL_ORGS = "all";

/** The org filter as the URL holds it: an org id, or nothing for every org. */
export function parseOrgParam(value: unknown, orgs: readonly OrgView[]): string | undefined {
  if (typeof value !== "string" || value === "" || value === ALL_ORGS) return undefined;
  return orgs.some((o) => o.id === value) || orgs.length === 0 ? value : undefined;
}

export function isOpen(task: Pick<TaskSummary, "status">): boolean {
  return task.status !== "done";
}

/** Whether a task shows under the org filter. Tasks without an org show only under All. */
export function inOrg(task: Pick<TaskSummary, "org">, org: string | undefined): boolean {
  return org === undefined || task.org === org;
}

export interface OrgRow {
  /** `undefined` is the All row. */
  id: string | undefined;
  name: string;
  badge: string;
  color: string | undefined;
  open: number;
}

/** "All workspaces" first, then each org with its badge, color and open task count. */
export function orgRows(orgs: readonly OrgView[], tasks: readonly TaskSummary[]): OrgRow[] {
  const open = tasks.filter(isOpen);
  return [
    // The All row has no letters: the switcher draws a layers icon in its tile.
    { id: undefined, name: "All workspaces", badge: "", color: undefined, open: open.length },
    ...orgs.map((org) => ({
      id: org.id,
      name: org.name,
      badge: badgeLetters(org.key),
      color: org.color,
      open: open.filter((t) => t.org === org.id).length,
    })),
  ];
}

// Agents right now -----------------------------------------------------------

export interface Pulse {
  working: number;
  paused: number;
  limit: number;
  idle: number;
}

/** Whether an account has no room left: the tool says so, or a usage window is full. */
export function accountAtLimit(account: AccountView | undefined): boolean {
  if (!account) return false;
  if (account.status === "at-limit") return true;
  const usage = account.usage;
  return (usage?.window?.usedPct ?? 0) >= 100;
}

/**
 * Counts every agent once: working when it is working in a task, paused when it sits in a paused task,
 * limit reached when its account is full, idle otherwise (the demo's order).
 */
export function agentsRightNow(
  agents: readonly AgentInfo[],
  tasks: readonly TaskSummary[],
  accounts: readonly AccountView[],
): Pulse {
  const pulse: Pulse = { working: 0, paused: 0, limit: 0, idle: 0 };
  const open = tasks.filter(isOpen);
  for (const agent of agents) {
    if (open.some((t) => t.status === "running" && t.working.includes(agent.id))) pulse.working += 1;
    else if (open.some((t) => t.status === "paused" && t.team.includes(agent.id))) pulse.paused += 1;
    else if (accountAtLimit(accounts.find((a) => a.id === agent.account))) pulse.limit += 1;
    else pulse.idle += 1;
  }
  return pulse;
}

/** Accounts the owner has to fix: signed out, unreachable or at their limit. */
export function accountsNeedingYou(accounts: readonly AccountView[]): AccountView[] {
  return accounts.filter(
    (a) => a.status === "needs-login" || a.status === "unreachable" || a.status === "at-limit",
  );
}

/** "Health checked 2 min ago", from the newest check of any account. */
export function healthCheckedText(accounts: readonly AccountView[], now: number): string {
  let newest: string | undefined;
  for (const account of accounts) {
    const at = account.lastHealth?.checkedAt;
    if (at && (newest === undefined || at > newest)) newest = at;
  }
  return newest ? `Health checked ${formatAgo(newest, now)}` : "Health not checked yet";
}

// Banner ---------------------------------------------------------------------

export type BannerTone = "amber" | "red";

export type BannerAction =
  /** `item`: the room item to scroll to. */
  | { kind: "task"; id: string; item?: string }
  | { kind: "chat"; id: string }
  | { kind: "page"; to: PagePath; search?: { account: string } }
  | { kind: "element"; id: string };

/** One thing that needs the owner: a row of the notifications panel, or the banner. */
export interface AttentionItem {
  key: string;
  tone: BannerTone;
  /** Paused for a limit, an error, a loop or a block; needs you for a question or a sign-in. */
  lamp: "needs" | "paused";
  text: string;
  actionLabel: string;
  action: BannerAction;
  /** The task or chat it is about, for the row's second line. Absent for an account. */
  task?: AttentionTask;
}

export type AttentionTask = Pick<TaskSummary, "id" | "title" | "org" | "chat">;

export interface Banner extends AttentionItem {
  /** How many other things also need the owner. */
  more: number;
}

export interface PendingPermission {
  task: string;
  agent: string;
  /** DOM id of the prompt, so the banner can bring it into view. */
  elementId: string;
}

export interface AttentionInput {
  tasks: readonly TaskSummary[];
  agents: ReadonlyMap<string, AgentInfo>;
  accounts: readonly AccountView[];
  now: number;
}

export interface BannerInput extends AttentionInput {
  permission: PendingPermission | undefined;
}

/** A task is named by its id, a chat by its title. */
function name(task: Pick<TaskSummary, "id" | "title" | "chat">): string {
  return task.chat === true ? task.title : task.id;
}

function open(task: Pick<TaskSummary, "id" | "chat">): BannerAction {
  return task.chat === true ? { kind: "chat", id: task.id } : { kind: "task", id: task.id };
}

function about(task: TaskSummary): AttentionTask {
  return task;
}

/** Tasks paused for the owner: a usage limit, an error, a loop, a block. */
function pauses(input: AttentionInput): AttentionItem[] {
  const found: AttentionItem[] = [];
  for (const task of input.tasks) {
    if (task.status !== "paused") continue;
    const agent = task.team[0] ? input.agents.get(task.team[0]) : undefined;
    if (task.pausedReason === "limit") {
      const account = agent ? input.accounts.find((a) => a.id === agent.account) : undefined;
      const resets = account?.usage?.window?.resetsAt ?? account?.usage?.weekly?.resetsAt;
      const who = account?.id ?? agent?.account;
      const reset = resets ? `, resets ${resetLabel(resets, input.now)}` : "";
      found.push({
        key: `limit:${task.id}`,
        tone: "amber",
        lamp: "paused",
        text: who
          ? `${task.id} is paused: ${who} hit its usage limit${reset}.`
          : `${task.id} is paused: its account hit the usage limit.`,
        actionLabel: `Open ${task.id}`,
        action: { kind: "task", id: task.id },
        task: about(task),
      });
    } else if (task.pausedReason === "error") {
      found.push({
        key: `error:${task.id}`,
        tone: "red",
        lamp: "paused",
        text: `${name(task)} paused after an error.`,
        actionLabel: "Open",
        action: open(task),
        task: about(task),
      });
    } else if (task.pausedReason === "loop") {
      found.push({
        key: `loop:${task.id}`,
        tone: "amber",
        lamp: "paused",
        text: `${name(task)} stopped: the agents were going in circles.`,
        actionLabel: "Open",
        action: open(task),
        task: about(task),
      });
    } else if (task.pausedReason === "blocked") {
      found.push({
        key: `blocked:${task.id}`,
        tone: "amber",
        lamp: "paused",
        text: `${name(task)} is blocked and waits for you.`,
        actionLabel: "Open",
        action: open(task),
        task: about(task),
      });
    }
  }
  return found;
}

/** A task or chat with an approval, a secret request or a question open, said in general words. */
function asking(task: TaskSummary): AttentionItem {
  return {
    key: `asking:${task.id}`,
    tone: "amber",
    lamp: "needs",
    text: `${name(task)} is waiting for your answer.`,
    actionLabel: "Open",
    action: open(task),
    task: about(task),
  };
}

/** Accounts signed out or not answering. */
function signIns(accounts: readonly AccountView[]): AttentionItem[] {
  return accounts
    .filter((a) => a.status === "needs-login" || a.status === "unreachable")
    .map<AttentionItem>((account) => ({
      key: `account:${account.id}`,
      tone: "red",
      lamp: "needs",
      text:
        account.status === "needs-login"
          ? `Sign in ${account.id}: its agents cannot run until you do.`
          : `${account.id} is not answering.`,
      actionLabel: "Accounts",
      action: { kind: "page", to: PAGE_PATH.accounts, search: { account: account.id } },
    }));
}

/**
 * Everything that needs the owner, most urgent first, for the notifications panel: limit pauses,
 * errors, loops and blocks, then each waiting approval, secret request or question (from
 * `notify.pending`, one row per item; a task the list has not caught up with gets one general row),
 * then sign-ins. The banner shows the first of the same list.
 */
export function attentionItems(
  input: AttentionInput & { pending: readonly PendingNotice[] },
): AttentionItem[] {
  const byTask = new Map<string, PendingNotice[]>();
  for (const notice of input.pending) byTask.set(notice.task, [...(byTask.get(notice.task) ?? []), notice]);
  const waiting = input.tasks
    .filter((task) => task.asking === true && task.status !== "done")
    .flatMap((task) => {
      const notices = byTask.get(task.id);
      if (notices === undefined) return [asking(task)];
      return notices.map<AttentionItem>((notice) => ({
        key: `notice:${task.id}:${notice.item}`,
        tone: "amber",
        lamp: "needs",
        text: notice.text,
        actionLabel: "Open",
        action: task.chat === true ? open(task) : { kind: "task", id: task.id, item: notice.item },
        task: about(task),
      }));
    });
  return [...pauses(input), ...waiting, ...signIns(input.accounts)];
}

/** The one thing that needs the owner most: limit pauses, errors, a prompt in the open task, then sign-ins. */
export function deriveBanner(input: BannerInput): Banner | null {
  const found: AttentionItem[] = pauses(input);
  // The task the owner is looking at shows its own prompt below, so it is not listed twice.
  for (const task of input.tasks) {
    if (task.asking !== true || task.status === "done" || task.id === input.permission?.task) continue;
    found.push(asking(task));
  }
  if (input.permission) {
    found.push({
      key: `permission:${input.permission.task}`,
      tone: "amber",
      lamp: "needs",
      text: `@${input.permission.agent} is waiting for your answer in ${input.permission.task}.`,
      actionLabel: "Show",
      action: { kind: "element", id: input.permission.elementId },
    });
  }
  found.push(...signIns(input.accounts));
  const [first, ...rest] = found;
  return first ? { ...first, more: rest.length } : null;
}
