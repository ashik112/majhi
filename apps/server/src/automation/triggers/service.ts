import { randomBytes } from "node:crypto";
import {
  type AutomationRun,
  defaultPollSeconds,
  describeWatch,
  minPollSeconds,
  type TriggerCreateInput,
  type TriggerUpdateInput,
  type TriggerView,
  type WatchSpec,
} from "@majhi/shared";
import { UserError } from "../../errors.ts";
import type { ActionRunner } from "../actions.ts";
import type { TriggerEngine } from "./engine.ts";
import { type Observer, validateWatch, type WatchHost } from "./observe.ts";
import type { TriggerRepo, TriggerRow } from "./repo.ts";

export interface TriggerServiceDeps {
  repo: TriggerRepo;
  runner: ActionRunner;
  engine: TriggerEngine;
  observer: Observer;
  host: WatchHost;
  /** Org ids that exist, Private included. */
  orgIds: () => Promise<ReadonlySet<string>>;
  now?: () => Date;
  changed?: () => void;
}

/** What the `triggers.*` commands do: check, save, and tell the engine. */
export class TriggerService {
  private readonly now: () => Date;

  constructor(private readonly deps: TriggerServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async list(org?: string): Promise<TriggerView[]> {
    await this.deps.runner.reconcile();
    return this.deps.repo.list(org).map((row) => this.view(row));
  }

  async get(id: string): Promise<TriggerView> {
    const row = this.row(id);
    await this.deps.runner.reconcile({ kind: "trigger", id });
    return this.view(row);
  }

  async runs(id: string, limit: number): Promise<AutomationRun[]> {
    this.row(id);
    await this.deps.runner.reconcile({ kind: "trigger", id });
    return this.deps.runner.history.list("trigger", id, limit);
  }

  async create(input: TriggerCreateInput): Promise<TriggerView> {
    if (!(await this.deps.orgIds()).has(input.org))
      throw new UserError(`Org "${input.org}" does not exist.`, 404);
    this.checkPoll(input.watch, input.pollSeconds);
    await validateWatch(input.org, input.watch, this.deps.host);
    await this.deps.runner.validate(input.org, input.action);
    const stamp = this.now().toISOString();
    const row: TriggerRow = {
      id: `trg-${randomBytes(5).toString("hex")}`,
      org: input.org,
      name: input.name,
      watch: input.watch,
      action: input.action,
      overlap: input.overlap,
      paused: false,
      pollSeconds: input.pollSeconds ?? null,
      settleSeconds: input.settleSeconds,
      cooldownSeconds: input.cooldownSeconds,
      baseline: null,
      lastFiredAt: null,
      lastRunId: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.deps.repo.insert(row);
    this.saved();
    // The first look sets what later looks are compared with, so it need not wait for the next tick.
    void this.deps.engine.tick();
    return this.view(row);
  }

  async update(input: TriggerUpdateInput): Promise<TriggerView> {
    const row = this.row(input.id);
    const watch = input.watch ?? row.watch;
    if (input.watch !== undefined) await validateWatch(row.org, watch, this.deps.host);
    if (input.watch !== undefined || input.pollSeconds !== undefined) {
      this.checkPoll(watch, input.pollSeconds ?? row.pollSeconds ?? undefined);
    }
    if (input.action !== undefined) await this.deps.runner.validate(row.org, input.action);
    this.deps.repo.update(
      row.id,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.action === undefined ? {} : { action: input.action }),
        ...(input.overlap === undefined ? {} : { overlap: input.overlap }),
        ...(input.pollSeconds === undefined ? {} : { pollSeconds: input.pollSeconds }),
        ...(input.settleSeconds === undefined ? {} : { settleSeconds: input.settleSeconds }),
        ...(input.cooldownSeconds === undefined ? {} : { cooldownSeconds: input.cooldownSeconds }),
        // A new watch starts from what it sees now: what the old one saw says nothing about it.
        ...(input.watch === undefined ? {} : { watch: input.watch, baseline: null }),
      },
      this.now().toISOString(),
    );
    this.deps.engine.forget(row.id);
    this.saved();
    return this.get(row.id);
  }

  async pause(id: string): Promise<TriggerView> {
    const row = this.row(id);
    if (!row.paused) {
      this.deps.repo.update(id, { paused: true }, this.now().toISOString());
      this.deps.engine.forget(id);
    }
    this.saved();
    return this.get(id);
  }

  /** Looks afresh: changes made while it was paused do not fire it. */
  async resume(id: string): Promise<TriggerView> {
    const row = this.row(id);
    if (row.paused) {
      this.deps.repo.update(id, { paused: false, baseline: null }, this.now().toISOString());
      this.deps.engine.forget(id);
    }
    this.saved();
    void this.deps.engine.tick();
    return this.get(id);
  }

  /** Follows the overlap rule, like a firing, but leaves the baseline and the cooldown alone. */
  async runNow(id: string): Promise<AutomationRun> {
    const row = this.row(id);
    const run = await this.deps.engine.run(row, "run by hand, nothing changed");
    this.saved();
    return run;
  }

  delete(id: string): { removed: string } {
    this.row(id);
    this.deps.repo.delete(id);
    this.deps.runner.history.deleteFor("trigger", id);
    this.deps.engine.forget(id);
    this.saved();
    return { removed: id };
  }

  private row(id: string): TriggerRow {
    const row = this.deps.repo.get(id);
    if (row === undefined) throw new UserError(`Trigger ${id} does not exist.`, 404);
    return row;
  }

  private checkPoll(watch: WatchSpec, pollSeconds: number | undefined): void {
    const min = minPollSeconds(watch.kind);
    if (pollSeconds !== undefined && pollSeconds < min) {
      throw new UserError(`A ${watch.kind} watch is checked every ${min} seconds at most.`);
    }
  }

  private saved(): void {
    this.deps.changed?.();
  }

  private view(row: TriggerRow): TriggerView {
    const lastRun = row.lastRunId === null ? undefined : this.deps.runner.history.get(row.lastRunId);
    const state = this.deps.engine.state(row.id);
    return {
      id: row.id as TriggerView["id"],
      org: row.org,
      name: row.name,
      watch: row.watch,
      watching: describeWatch(row.watch),
      action: row.action,
      overlap: row.overlap,
      paused: row.paused,
      pollSeconds: row.pollSeconds ?? defaultPollSeconds(row.watch.kind),
      settleSeconds: row.settleSeconds,
      cooldownSeconds: row.cooldownSeconds,
      lastCheckedAt: state.lastCheckedAt,
      checkError: state.checkError,
      pending: state.pending,
      lastFiredAt: row.lastFiredAt,
      lastRun: lastRun ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
