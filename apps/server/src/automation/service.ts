import {
  type AutomationRun,
  clockPlaybookSpec,
  DEFAULT_TIME_ZONE,
  nextRunAfter,
  resolveSpec,
  type ScheduleCreateInput,
  type ScheduleUpdateInput,
  type ScheduleView,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { Catalog } from "../playbooks/catalog.ts";
import { customId, customPlaybook } from "../playbooks/custom.ts";
import type { ActionRunner } from "./actions.ts";
import type { Scheduler } from "./scheduler.ts";
import type { ScheduleRepo, ScheduleRow } from "./schedules.ts";

export interface ScheduleServiceDeps {
  repo: ScheduleRepo;
  runner: ActionRunner;
  scheduler: Scheduler;
  /** The playbook catalog: a schedule is a clock playbook and is listed there. */
  catalog: Catalog;
  /** Org ids that exist, Private included. */
  orgIds: () => Promise<ReadonlySet<string>>;
  now?: () => Date;
  changed?: () => void;
}

/**
 * What the `schedules.*` commands do: check, save, and tell the scheduler. A schedule is a clock
 * playbook (SPEC 5.18): these commands are thin aliases kept for callers that still name schedules.
 */
export class ScheduleService {
  private readonly now: () => Date;

  constructor(private readonly deps: ScheduleServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async list(org?: string): Promise<ScheduleView[]> {
    await this.deps.runner.reconcile();
    return this.deps.repo.list(org).map((row) => this.view(row));
  }

  /** Ends the runs whose task or process finished, so the views read true. */
  reconcile(): Promise<void> {
    return this.deps.runner.reconcile();
  }

  /** One schedule as it stands, without ending finished runs first. */
  peek(id: string): ScheduleView | undefined {
    const row = this.deps.repo.get(id);
    return row === undefined ? undefined : this.view(row);
  }

  /** The last runs, newest first, as they stand. */
  recent(id: string, limit: number): AutomationRun[] {
    return this.deps.runner.history.list("schedule", id, limit);
  }

  async get(id: string): Promise<ScheduleView> {
    const row = this.row(id);
    await this.deps.runner.reconcile({ kind: "schedule", id });
    return this.view(row);
  }

  async runs(id: string, limit: number): Promise<AutomationRun[]> {
    this.row(id);
    await this.deps.runner.reconcile({ kind: "schedule", id });
    return this.deps.runner.history.list("schedule", id, limit);
  }

  async create(input: ScheduleCreateInput, opts: { enabled?: boolean } = {}): Promise<ScheduleView> {
    if (!(await this.deps.orgIds()).has(input.org))
      throw new UserError(`Org "${input.org}" does not exist.`, 404);
    const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE;
    const resolved = resolveSpec(input, timeZone);
    if (!resolved.ok) throw new UserError(resolved.error);
    await this.deps.runner.validate(input.org, input.action);
    const at = this.now();
    const next = nextRunAfter(resolved.spec, timeZone, at);
    if (next === undefined) throw new UserError(this.neverRuns(resolved.spec.kind));
    const stamp = at.toISOString();
    const enabled = opts.enabled ?? true;
    const row: ScheduleRow = {
      id: customId(input.name),
      org: input.org,
      name: input.name,
      spec: resolved.spec,
      timeZone,
      action: input.action,
      overlap: input.overlap,
      paused: !enabled,
      done: false,
      nextRunAt: enabled ? next.toISOString() : null,
      lastRunId: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.deps.repo.insert(row);
    this.sync(row.id);
    this.saved();
    return this.view(row);
  }

  async update(input: ScheduleUpdateInput): Promise<ScheduleView> {
    const row = this.row(input.id);
    const timeZone = input.timeZone ?? row.timeZone;
    const whenChanged =
      input.spec !== undefined || input.phrase !== undefined || input.timeZone !== undefined;
    let spec = row.spec;
    if (input.spec !== undefined || input.phrase !== undefined) {
      const resolved = resolveSpec(input, timeZone);
      if (!resolved.ok) throw new UserError(resolved.error);
      spec = resolved.spec;
    }
    if (input.action !== undefined) await this.deps.runner.validate(row.org, input.action);
    const patch: Parameters<ScheduleRepo["update"]>[1] = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.overlap === undefined ? {} : { overlap: input.overlap }),
      ...(input.action === undefined ? {} : { action: input.action }),
    };
    if (whenChanged) {
      const next = nextRunAfter(spec, timeZone, this.now());
      if (next === undefined) throw new UserError(this.neverRuns(spec.kind));
      // A new time brings a finished one-off back; a paused schedule stays paused.
      Object.assign(patch, {
        spec,
        timeZone,
        done: false,
        nextRunAt: row.paused ? null : next.toISOString(),
      });
    }
    this.deps.repo.update(row.id, patch, this.now().toISOString());
    this.sync(row.id);
    this.saved();
    return this.get(row.id);
  }

  async pause(id: string): Promise<ScheduleView> {
    const row = this.row(id);
    if (!row.paused) this.deps.repo.update(id, { paused: true, nextRunAt: null }, this.now().toISOString());
    this.saved();
    return this.get(id);
  }

  /** The next slot counts from now: what was missed while paused is not replayed. */
  async resume(id: string): Promise<ScheduleView> {
    const row = this.row(id);
    if (row.done)
      throw new UserError("This one-off schedule already ran. Edit its time to run it again.", 409);
    if (row.paused) {
      const next = nextRunAfter(row.spec, row.timeZone, this.now());
      if (next === undefined) throw new UserError(`${this.neverRuns(row.spec.kind)} Edit it first.`, 409);
      this.deps.repo.update(id, { paused: false, nextRunAt: next.toISOString() }, this.now().toISOString());
    }
    this.saved();
    return this.get(id);
  }

  /** Follows the overlap rule: with `skip`, the run comes back as skipped while the last one goes. */
  async runNow(id: string): Promise<AutomationRun> {
    const row = this.row(id);
    const run = await this.deps.scheduler.execute(row);
    this.saved();
    return run;
  }

  delete(id: string): { removed: string } {
    this.row(id);
    this.deps.repo.delete(id);
    this.deps.catalog.unregister(id);
    this.deps.runner.history.deleteFor("schedule", id);
    this.saved();
    return { removed: id };
  }

  /** Puts the playbook the row describes into the catalog, new or changed. */
  sync(id: string): void {
    const row = this.deps.repo.get(id);
    if (row === undefined) return;
    this.deps.catalog.put(
      customPlaybook(
        id,
        clockPlaybookSpec(row.name, {
          org: row.org,
          when: row.spec,
          timeZone: row.timeZone,
          action: row.action,
          overlap: row.overlap,
        }),
      ),
    );
  }

  private row(id: string): ScheduleRow {
    const row = this.deps.repo.get(id);
    if (row === undefined) throw new UserError(`Schedule ${id} does not exist.`, 404);
    return row;
  }

  private saved(): void {
    this.deps.scheduler.arm();
    this.deps.changed?.();
  }

  private neverRuns(kind: string): string {
    return kind === "once" ? "That time has already passed." : "That schedule never runs again.";
  }

  private view(row: ScheduleRow): ScheduleView {
    const lastRun = row.lastRunId === null ? undefined : this.deps.runner.history.get(row.lastRunId);
    return {
      id: row.id as ScheduleView["id"],
      org: row.org,
      name: row.name,
      spec: row.spec,
      timeZone: row.timeZone,
      action: row.action,
      overlap: row.overlap,
      paused: row.paused,
      done: row.done,
      nextRunAt: row.paused || row.done ? null : row.nextRunAt,
      lastRun: lastRun ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
