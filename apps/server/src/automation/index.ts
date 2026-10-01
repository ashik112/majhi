import type Database from "better-sqlite3";
import { type ActionHost, ActionRunner } from "./actions.ts";
import { RunHistory } from "./history.ts";
import { Scheduler, type Timers } from "./scheduler.ts";
import { ScheduleRepo } from "./schedules.ts";
import { ScheduleService } from "./service.ts";
import { TriggerEngine } from "./triggers/engine.ts";
import { Observer, type WatchHost } from "./triggers/observe.ts";
import { TriggerRepo } from "./triggers/repo.ts";
import { TriggerService } from "./triggers/service.ts";

export interface AutomationDeps {
  db: Database.Database;
  host: ActionHost;
  /** What watch triggers look at. */
  watch: WatchHost;
  orgIds: () => Promise<ReadonlySet<string>>;
  changed: () => void;
  /** A trigger fired, was edited or ran into a problem. */
  triggersChanged: () => void;
  now?: () => Date;
  timers?: Timers;
}

export interface Automation {
  /** Runs actions and keeps the run history, for schedules and watch triggers alike. */
  runner: ActionRunner;
  schedules: ScheduleService;
  scheduler: Scheduler;
  triggers: TriggerService;
  triggerEngine: TriggerEngine;
}

/** Schedules, the run loop, and the action runner they share with watch triggers. */
export function createAutomation(deps: AutomationDeps): Automation {
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
    orgIds: deps.orgIds,
    changed: deps.changed,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  const triggerRepo = new TriggerRepo(deps.db);
  const observer = new Observer(deps.watch);
  const triggerEngine = new TriggerEngine({
    repo: triggerRepo,
    runner,
    observer,
    changed: deps.triggersChanged,
    onError: (message) => console.error(message),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.timers === undefined ? {} : { timers: deps.timers }),
  });
  const triggers = new TriggerService({
    repo: triggerRepo,
    runner,
    engine: triggerEngine,
    observer,
    host: deps.watch,
    orgIds: deps.orgIds,
    changed: deps.triggersChanged,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  return { runner, schedules, scheduler, triggers, triggerEngine };
}
