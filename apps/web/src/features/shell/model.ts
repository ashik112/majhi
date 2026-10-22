import type { AccountView, OrgView, PagePath, TaskSummary } from "@majhi/shared";

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

// Accounts ------------------------------------------------------------------

/** Whether an account has no room left: the tool says so, or a usage window is full. */
export function accountAtLimit(account: AccountView | undefined): boolean {
  if (!account) return false;
  if (account.status === "at-limit" || account.limit !== undefined) return true;
  const usage = account.usage;
  return (usage?.window?.usedPct ?? 0) >= 100;
}

/** Accounts the owner has to fix: signed out, unreachable or at their limit. */
export function accountsNeedingYou(accounts: readonly AccountView[]): AccountView[] {
  return accounts.filter(
    (a) => a.status === "needs-login" || a.status === "unreachable" || a.status === "at-limit",
  );
}

// Where "Open" goes ----------------------------------------------------------

export type BannerAction =
  /** `item`: the room item to scroll to. */
  | { kind: "task"; id: string; item?: string }
  | { kind: "chat"; id: string }
  | {
      kind: "page";
      to: PagePath;
      search?: {
        account?: string;
        signin?: "start";
        id?: string;
        tab?: string;
        rules?: true;
        settings?: true;
        create?: string;
      };
    };
