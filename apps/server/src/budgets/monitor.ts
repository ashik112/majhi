import type {
  Budget,
  BudgetRow,
  BudgetScope,
  BudgetStatus,
  BudgetsSettings,
  BudgetThreshold,
} from "@majhi/shared";
import { errorMessage } from "../errors.ts";
import { defaultTimeZone, localDay } from "../usage/ranges.ts";
import type { UsageRepo } from "../usage/repo.ts";
import type { BudgetAlertRepo } from "./repo.ts";
import {
  type BudgetUse,
  budgetTokens,
  budgetUse,
  planAlerts,
  type Spend,
  type WeekWindow,
  weekWindow,
} from "./thresholds.ts";

/** An alert that just fired. */
export interface FiredAlert extends BudgetUse {
  scope: BudgetScope;
  id: string;
  threshold: BudgetThreshold;
  budget: Budget;
  spend: Spend;
  week: WeekWindow;
  /** The task of the newest turn this week for this org or account: where the line is posted. */
  task: string | undefined;
}

export interface BudgetMonitorDeps {
  usage: UsageRepo;
  alerts: BudgetAlertRepo;
  /** The budgets in majhi.yaml, read each time so a change applies at once. */
  budgets: () => Promise<BudgetsSettings>;
  /** Says the alert: a quiet room line and a server event. */
  announce: (alert: FiredAlert) => void;
  /** An alert fired or was re-armed: tell open pages. */
  onChange?: () => void;
  /** The 100% action (`limit-action.ts`). */
  onLimit: (alert: FiredAlert) => Promise<void>;
  /** Resumes the runs a budget paused that no budget holds now (`lift`). */
  lift?: () => Promise<void>;
  tz?: string;
  now?: () => Date;
}

/** Sums this week's turns against the weekly budgets and fires the 80% and 100% alerts once each. */
export class BudgetMonitor {
  private readonly tz: string;

  constructor(private readonly deps: BudgetMonitorDeps) {
    this.tz = deps.tz ?? defaultTimeZone();
  }

  private window(): WeekWindow {
    return weekWindow(localDay(this.deps.now?.() ?? new Date(), this.tz), this.tz);
  }

  private spend(scope: BudgetScope, id: string, week: WeekWindow): Spend {
    const filters = scope === "org" ? { org: id } : { account: id };
    const t = this.deps.usage.totals({ filters, start: week.start, end: week.end });
    return { tokens: budgetTokens(t), cost: t.costUsd };
  }

  /** A turn was recorded for this org and account: check both budgets. Never throws. */
  async afterTurn(turn: { org: string | null; account: string }): Promise<void> {
    try {
      const { orgs, accounts } = await this.deps.budgets();
      const week = this.window();
      const org = turn.org === null ? undefined : orgs[turn.org];
      if (turn.org !== null && org !== undefined) await this.check("org", turn.org, org, week);
      const account = accounts[turn.account];
      if (account !== undefined) await this.check("account", turn.account, account, week);
    } catch (err) {
      console.error(`Could not check the budgets after a turn of ${turn.account}: ${errorMessage(err)}`);
    }
  }

  /**
   * The budgets changed: check them all. A raised budget re-arms the thresholds it is now under; a
   * lowered one may fire at once.
   */
  async recheck(): Promise<void> {
    try {
      const { orgs, accounts } = await this.deps.budgets();
      const week = this.window();
      for (const [id, budget] of Object.entries(orgs)) await this.check("org", id, budget, week);
      for (const [id, budget] of Object.entries(accounts)) await this.check("account", id, budget, week);
    } catch (err) {
      console.error(`Could not check the budgets after a change: ${errorMessage(err)}`);
    }
    await this.lift();
  }

  /**
   * Whether a run of `task` may not start a turn: an org or account budget it counts against has
   * fired its 100% alert this week, and the owner has not resumed this task since. Returns the line
   * to say, or undefined. Read between turns, so a turn that is running finishes.
   */
  async limitedFor(run: {
    org: string | null;
    account: string | undefined;
    task: string;
  }): Promise<string | undefined> {
    const { orgs, accounts } = await this.deps.budgets();
    const week = this.window();
    const resumed = this.deps.alerts.resumedAt(run.task);
    const scopes: [BudgetScope, string | undefined, Budget | undefined][] = [
      ["org", run.org ?? undefined, run.org === null ? undefined : orgs[run.org]],
      ["account", run.account, run.account === undefined ? undefined : accounts[run.account]],
    ];
    for (const [scope, id, budget] of scopes) {
      if (id === undefined || budget === undefined) continue;
      const alert = this.deps.alerts.fired(scope, id, week.weekStart).find((a) => a.threshold === 100);
      if (alert === undefined || (resumed !== undefined && resumed > alert.at)) continue;
      return `The ${scope} ${id} reached its weekly budget, so this agent waits. It continues when the budget is raised, when the task is resumed by hand, or on Monday.`;
    }
    return undefined;
  }

  /** The owner resumed this task by hand: the 100% alerts so far no longer hold it. */
  exempt(task: string): void {
    this.deps.alerts.setResumed(task, (this.deps.now?.() ?? new Date()).toISOString());
  }

  /** Resumes what no budget holds any more: a raised or removed budget, or a new week. */
  async lift(): Promise<void> {
    try {
      await this.deps.lift?.();
    } catch (err) {
      console.error(`Could not lift the budget pauses: ${errorMessage(err)}`);
    }
  }

  /** Per budgeted org and account: use, week and alerts (`budgets.status`). */
  async status(): Promise<BudgetStatus> {
    const { orgs, accounts } = await this.deps.budgets();
    const week = this.window();
    const row = (scope: BudgetScope, id: string, budget: Budget): BudgetRow => {
      const used = this.spend(scope, id, week);
      const alerts = this.deps.alerts.fired(scope, id, week.weekStart);
      return {
        scope,
        id,
        budget,
        used,
        ...budgetUse(used, budget),
        weekStart: week.weekStart,
        resetsAt: week.end,
        alerts,
        paused: alerts.some((a) => a.threshold === 100),
      };
    };
    return {
      tz: this.tz,
      rows: [
        ...Object.entries(orgs).map(([id, b]) => row("org", id, b)),
        ...Object.entries(accounts).map(([id, b]) => row("account", id, b)),
      ],
    };
  }

  private async check(scope: BudgetScope, id: string, budget: Budget, week: WeekWindow): Promise<void> {
    const spend = this.spend(scope, id, week);
    const use = budgetUse(spend, budget);
    const fired = this.deps.alerts.fired(scope, id, week.weekStart).map((a) => a.threshold);
    const plan = planAlerts(use.percent, fired);
    for (const t of plan.rearm) this.deps.alerts.remove(scope, id, week.weekStart, t);
    const at = (this.deps.now?.() ?? new Date()).toISOString();
    const fresh = plan.fire.filter((t) => this.deps.alerts.add(scope, id, week.weekStart, t, at));
    if (plan.rearm.length > 0 || fresh.length > 0) this.deps.onChange?.();
    const top = fresh.at(-1);
    if (top === undefined) return;
    const filters = scope === "org" ? { org: id } : { account: id };
    const newest = this.deps.usage.list({ filters, start: week.start, end: week.end }, 1)[0];
    const alert: FiredAlert = { scope, id, threshold: top, budget, spend, week, task: newest?.task, ...use };
    this.deps.announce(alert);
    if (top === 100) {
      try {
        await this.deps.onLimit(alert);
      } catch (err) {
        console.error(`The 100% action for ${scope} ${id} failed: ${errorMessage(err)}`);
      }
    }
  }
}
