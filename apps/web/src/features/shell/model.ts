import type { AccountView, OrgView, TaskSummary } from "@majhi/shared";
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

/** "All orgs" first, then each org with its badge, color and open task count. */
export function orgRows(orgs: readonly OrgView[], tasks: readonly TaskSummary[]): OrgRow[] {
  const open = tasks.filter(isOpen);
  return [
    { id: undefined, name: "All orgs", badge: "*", color: undefined, open: open.length },
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
  | { kind: "task"; id: string }
  | { kind: "page"; to: PagePath }
  | { kind: "element"; id: string };

export interface Banner {
  key: string;
  tone: BannerTone;
  text: string;
  actionLabel: string;
  action: BannerAction;
  /** How many other things also need the owner. */
  more: number;
}

export interface PendingPermission {
  task: string;
  agent: string;
  /** DOM id of the prompt, so the banner can bring it into view. */
  elementId: string;
}

export interface BannerInput {
  tasks: readonly TaskSummary[];
  agents: ReadonlyMap<string, AgentInfo>;
  accounts: readonly AccountView[];
  permission: PendingPermission | undefined;
  now: number;
}

/** The one thing that needs the owner most: limit pauses, errors, a prompt in the open task, then sign-ins. */
export function deriveBanner(input: BannerInput): Banner | null {
  const found: Omit<Banner, "more">[] = [];

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
        text: who
          ? `${task.id} is paused: ${who} hit its usage limit${reset}.`
          : `${task.id} is paused: its account hit the usage limit.`,
        actionLabel: `Open ${task.id}`,
        action: { kind: "task", id: task.id },
      });
    } else if (task.pausedReason === "error") {
      found.push({
        key: `error:${task.id}`,
        tone: "red",
        text: `${task.id} paused after an error.`,
        actionLabel: `Open ${task.id}`,
        action: { kind: "task", id: task.id },
      });
    }
  }

  if (input.permission) {
    found.push({
      key: `permission:${input.permission.task}`,
      tone: "amber",
      text: `@${input.permission.agent} is waiting for your answer in ${input.permission.task}.`,
      actionLabel: "Show",
      action: { kind: "element", id: input.permission.elementId },
    });
  }

  const signedOut = input.accounts.filter((a) => a.status === "needs-login" || a.status === "unreachable");
  for (const account of signedOut) {
    found.push({
      key: `account:${account.id}`,
      tone: "red",
      text:
        account.status === "needs-login"
          ? `${account.id} needs you to sign in.`
          : `${account.id} is not answering.`,
      actionLabel: "Health and usage",
      action: { kind: "page", to: PAGE_PATH.usage },
    });
  }

  const [first, ...rest] = found;
  return first ? { ...first, more: rest.length } : null;
}
