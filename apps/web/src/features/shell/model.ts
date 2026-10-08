import type { AccountView, OrgView, OwnerDecision, PagePath, TaskSummary } from "@majhi/shared";
import type { AgentInfo } from "../../lib/agent-index";
import { badgeLetters, formatAgo } from "../../lib/format";
import { actionOf, openLabel, workspaceOf } from "../decisions/model";

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
  if (account.status === "at-limit" || account.limit !== undefined) return true;
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

/**
 * When health was last checked: the newest of every account's check and the page's own run of the
 * checks. The sidebar and the Health page both read it, so they never show two clocks.
 */
export function healthCheckedAt(accounts: readonly AccountView[], checksAt?: string): string | undefined {
  let newest = checksAt;
  for (const account of accounts) {
    const at = account.lastHealth?.checkedAt;
    if (at && (newest === undefined || at > newest)) newest = at;
  }
  return newest;
}

/** "Health checked 2 min ago", from the newest check of any kind. */
export function healthCheckedText(accounts: readonly AccountView[], now: number, checksAt?: string): string {
  const newest = healthCheckedAt(accounts, checksAt);
  return newest ? `Health checked ${formatAgo(newest, now)}` : "Health not checked yet";
}

// Banner ---------------------------------------------------------------------

export type BannerTone = "amber" | "red";

export type BannerAction =
  /** `item`: the room item to scroll to. */
  | { kind: "task"; id: string; item?: string }
  | { kind: "chat"; id: string }
  | {
      kind: "page";
      to: PagePath;
      search?: { account?: string; signin?: "start"; id?: string; tab?: string; section?: string };
    }
  | { kind: "element"; id: string };

/** The one thing that needs the owner most, as the banner above the page shows it. */
export interface Banner {
  key: string;
  tone: BannerTone;
  /** Paused for a limit, an error, a loop or a block; needs you for a question or a sign-in. */
  lamp: "needs" | "paused";
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

/** Which decision the banner leads with: what is stuck first, then what asks, then work to ship. */
function bannerRank(d: OwnerDecision): number {
  switch (d.kind) {
    case "incident":
      return 0;
    case "sign-in":
      return 1;
    case "paused":
      return 2;
    case "ship":
      return 4;
    default:
      return 3;
  }
}

/** The decisions Home draws as rows: all of them, narrowed to the workspace filter. */
export function homeRowIds(
  decisions: readonly OwnerDecision[] | undefined,
  org: string | undefined,
): ReadonlySet<string> {
  return new Set(
    (decisions ?? []).filter((d) => org === undefined || workspaceOf(d) === org).map((d) => d.id),
  );
}

/**
 * The banner, from the decisions the server lists and nothing else, so it cannot name something the
 * Needs you page does not. On a task's page it leaves out that task's own decisions. The prompt waiting
 * in the chat the owner has open points at itself.
 */
export function deriveBanner(input: {
  decisions: readonly OwnerDecision[] | undefined;
  permission: PendingPermission | undefined;
  /** Decisions the page already draws as rows: the banner never repeats them. */
  onScreen?: ReadonlySet<string> | undefined;
  /** The task page the owner has open: what is about that task is already in front of them. */
  openTask?: string | undefined;
  /** Decisions the owner closed the banner for, this session. */
  dismissed?: ReadonlySet<string> | undefined;
}): Banner | null {
  const all = (input.decisions ?? []).filter(
    (d) =>
      input.onScreen?.has(d.id) !== true &&
      input.dismissed?.has(d.id) !== true &&
      (input.openTask === undefined || d.task !== input.openTask),
  );
  const first = all.toSorted((a, b) => bannerRank(a) - bannerRank(b))[0];
  if (first === undefined) return null;
  const more = all.length - 1;
  const here = input.permission;
  if (first.kind === "approval" && here !== undefined && first.task === here.task) {
    return {
      key: first.id,
      tone: "amber",
      lamp: "needs",
      text: `@${here.agent} is waiting for your answer in ${here.task}.`,
      actionLabel: "Show",
      action: { kind: "element", id: here.elementId },
      more,
    };
  }
  return {
    key: first.id,
    tone: first.kind === "incident" || first.kind === "sign-in" ? "red" : "amber",
    lamp: first.kind === "paused" ? "paused" : "needs",
    text: first.sentence ?? first.title,
    actionLabel: openLabel(first.link),
    action: actionOf(first.link),
    more,
  };
}
