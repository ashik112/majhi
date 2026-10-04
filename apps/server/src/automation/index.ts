import type Database from "better-sqlite3";
import type { Catalog } from "../playbooks/catalog.ts";
import { type ActionHost, ActionRunner } from "./actions.ts";
import { RunHistory } from "./history.ts";
import { migrateAutomations } from "./migrate.ts";
import { Scheduler, type Timers } from "./scheduler.ts";
import { ScheduleRepo } from "./schedules.ts";
import { ScheduleService } from "./service.ts";

export interface AutomationDeps {
  db: Database.Database;
  /** The playbook catalog the clock playbooks are listed in. */
  catalog: Catalog;
  host: ActionHost;
  orgIds: () => Promise<ReadonlySet<string>>;
  changed: () => void;
  now?: () => Date;
  timers?: Timers;
}

export interface Automation {
  /** Runs actions and keeps the run history, for schedules and watch triggers alike. */
  runner: ActionRunner;
  schedules: ScheduleService;
  scheduler: Scheduler;
}

/**
 * The clock playbooks' run loop (they were the schedules) and the action runner they share with
 * watches. Copies what Automations held into Playbooks and Watch first (`migrate.ts`).
 */
export function createAutomation(deps: AutomationDeps): Automation {
  const moved = migrateAutomations(deps.db);
  if (moved.schedules > 0 || moved.triggers > 0) {
    console.error(
      `Automations moved: ${moved.schedules} schedules to playbooks, ${moved.triggers} triggers to watches.`,
    );
  }
  const history = new RunHistory(deps.db);
  const runner = new ActionRunner(deps.host, history, deps.now);
  const repo = new ScheduleRepo(deps.db);
  const scheduler = new Scheduler({
    repo,
    runner,
    changed: deps.changed,
    onError: (message) => console.error(message),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.timers === undefined ? {} : { timers: deps.timers }),
  });
  const schedules = new ScheduleService({
    repo,
    runner,
    scheduler,
    catalog: deps.catalog,
    orgIds: deps.orgIds,
    changed: deps.changed,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  return { runner, schedules, scheduler };
}
