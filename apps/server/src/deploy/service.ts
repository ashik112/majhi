import {
  type DeployEnvironment,
  type DeployHoldInputSchema,
  type DeployInput,
  type DeployRecord,
  type DeployResult,
  type DeployRunStep,
  deployHasCommit,
  deployIsActive,
  type PlanDeployInput,
  type PlanDeployResult,
  PRIVATE,
  plannedCommit,
  type RemoteConfig,
} from "@majhi/shared";
import type { z } from "zod";
import { errorMessage, UserError } from "../errors.ts";
import type { DeployRepo } from "../store/deploys.ts";
import type { DeployGit } from "./git.ts";
import { type DeployRefusal, deployIsUnchecked, deployRefusal } from "./guards.ts";
import { incidentBrief } from "./incident.ts";
import {
  type DeployContext,
  DeployProblem,
  type DeployProvider,
  type ProviderDeps,
  type Providers,
  type RepoRef,
  type RunHandle,
} from "./types.ts";
import { type VerifyDeps, verifyDeploy } from "./verify.ts";

/**
 * Deploys (docs/briefs/deploy-v2.md). `plan` writes a task's steps as planned records. `deploy` decides
 * whether a deploy may start, makes (or takes) the one record for the environment and commit, and returns at once;
 * the record's runs are followed in the background, in order, until they end, then checked. A failed run or check
 * rolls back, opens an incident task and tells the owner.
 *
 * Every step is keyed by the record: asking again for the same environment and commit finds the record, so a
 * deploy is never started twice, and a restart picks up the records that were moving.
 */

export interface DeployProject {
  id: string;
  org: string;
  path: string;
  base: string | undefined;
  remotes: Readonly<Record<string, RemoteConfig>>;
  environments: readonly DeployEnvironment[];
}

export interface DeployTask {
  id: string;
  org: string | undefined;
}

export interface DeployDeps {
  repo: DeployRepo;
  projects: { get(id: string): Promise<DeployProject> };
  tasks: { get(id: string): DeployTask | undefined; landedCommits(project: string): ReadonlySet<string> };
  git: DeployGit;
  /** The host and repo of one of the project's remotes (default: the one merge requests go to). Undefined when it is not a host a provider reaches. */
  repoRef(project: DeployProject, remote?: string): Promise<RepoRef | undefined>;
  /** The project's card sets a test, build or lint command, so a commit no merge produced is unverified. */
  checksConfigured(project: string): boolean;
  providers: Providers;
  providerDeps: ProviderDeps;
  /** One look at an environment's check address. */
  looks: Pick<VerifyDeps, "health">;
  /** How long the check after the runs lasts. */
  checkSeconds: number;
  /** Opens the incident task of a failed deploy and returns its id. */
  openIncident(input: {
    org: string;
    project: string;
    record: DeployRecord;
    title: string;
    text: string;
  }): Promise<string | undefined>;
  tellOwner(org: string, key: string, text: string): void;
  audit(row: {
    org: string;
    task: string;
    by: DeployRecord["by"];
    ok: boolean;
    title: string;
    detail: string;
  }): void;
  /** Something about deploys changed: screens read again. */
  changed(): void;
  /** A deploy went live: the next step of the plan may go now. */
  onLive?: (record: DeployRecord) => void;
  /** A task's plan came back empty: nothing deploys for its head. Kept so the ship decision does not wait for a plan. */
  nothingDeploys?: (task: string, by: DeployActor) => Promise<void>;
  /** One line in the room of the task a deploy belongs to, keyed so a repeat says nothing new. */
  taskNote?: (task: string, key: string, level: "info" | "warn", text: string) => void;
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Time between looks at a run, and between looks of the check. */
  pollMs: number;
  verifyMs: number;
  /** A run that has not ended by then failed. */
  runTimeoutMs: number;
}

export type DeployActor = DeployRecord["by"];

/** What a deploy asks for: an environment of a project, the runs to start, and what it ships. */
export interface DeployRequest {
  project: string;
  env: string;
  runs: readonly DeployRunStep[];
  /** Default: the project's base branch tip. */
  commit?: string | undefined;
  task?: string | undefined;
  confirmUnchecked?: boolean | undefined;
  /** The record this is a step of, when it is one. */
  record?: DeployRecord | undefined;
}

/** What a decision to deploy says before anything starts: the sentence that stops it, or what it would run with. */
export type Evaluated =
  | { ok: false; why: string; kind: DeployRefusal["kind"] | "setup" | "unpushed" }
  | { ok: true; project: DeployProject; env: DeployEnvironment; ctx: DeployContext; unchecked: boolean };

/** Calls to a provider that fail this many times in a row end the follow: what the run did is not known. */
const MAX_POLL_ERRORS = 5;
/** How long the host's answer about a commit is kept: a board that reads every few seconds asks the host once. */
const PREFLIGHT_KEEP_MS = 30_000;

const reasonOf = (err: unknown): string => {
  const text = err instanceof DeployProblem ? err.message : errorMessage(err);
  return text.length > 600 ? `${text.slice(0, 599)}…` : text;
};

export class DeployService {
  private readonly flying = new Set<Promise<void>>();
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly rollingBack = new Set<number>();
  private readonly listeners: (() => void)[] = [];
  private readonly preflights = new Map<
    string,
    { at: number; answer: { kind: "unpushed" | "setup"; why: string } | undefined }
  >();

  constructor(private readonly deps: DeployDeps) {}

  private contextFor(
    project: DeployProject,
    env: DeployEnvironment,
    commit: string,
    base: string,
  ): DeployContext {
    return {
      org: project.org,
      project: project.id,
      env,
      base,
      commit,
      repoOf: (remote) => this.deps.repoRef(project, remote),
    };
  }

  /** Why a deploy of the commit to the environment may not start, or what it would run with. Starts nothing. */
  async evaluate(req: DeployRequest, actor: DeployActor, rest?: string): Promise<Evaluated> {
    const project = await this.deps.projects.get(req.project);
    const env = project.environments.find((e) => e.env === req.env);
    if (env === undefined) {
      return { ok: false, kind: "setup", why: `${project.id} has no ${req.env} environment.` };
    }
    if (req.runs.length === 0) {
      return { ok: false, kind: "setup", why: `The deploy of ${req.env} has no runs to start.` };
    }
    if (actor === "captain" && req.runs.some((r) => r.kind === "ssh")) {
      return { ok: false, kind: "setup", why: "An ssh run is the owner's: the captain does not start one." };
    }
    if (req.task !== undefined) {
      const task = this.deps.tasks.get(req.task);
      if ((task?.org ?? PRIVATE) !== project.org) {
        return { ok: false, kind: "setup", why: `${req.task} is not in the workspace of ${project.id}.` };
      }
    }
    const base = project.base;
    if (base === undefined) return { ok: false, kind: "setup", why: `${project.id} has no base branch.` };
    const tip = await this.deps.git.tip(project.path, base);
    const commit = req.commit ?? tip;
    if (commit === undefined) {
      return { ok: false, kind: "unreadable", why: "majhi could not read the project's base branch." };
    }
    // The steps of the current plan before this one go first, each live. A step of an older plan does not count:
    // one that went out at another commit of this project, or that a later step of the same environment replaced.
    const before =
      req.record === undefined || req.record.task === undefined
        ? []
        : (() => {
            const all = this.deps.repo.ofTask(req.record.task);
            return all
              .filter((r) => r.seq < (req.record?.seq ?? 0))
              .filter((r) => !(r.project === project.id && deployHasCommit(r) && r.commit !== commit))
              .filter(
                (r) => !all.some((o) => o.seq > r.seq && o.project === r.project && o.env === r.env),
              )
              .map((r) => ({ env: `${r.project} ${r.env}`, live: r.state === "live" }));
          })();
    const facts = {
      actor,
      commit,
      tip,
      landed: this.deps.tasks.landedCommits(project.id).has(commit),
      checksConfigured: this.deps.checksConfigured(project.id),
      confirmUnchecked: req.confirmUnchecked === true,
      before,
      rest,
    };
    const refused = deployRefusal(facts);
    if (refused !== undefined) return { ok: false, ...refused };
    const ctx = this.contextFor(project, env, commit, base);
    // The host must have the commit before a run starts. A commit not pushed yet is a wait, not a failure.
    const missing = await this.hostLacks(ctx, req.runs);
    if (missing !== undefined) return { ok: false, ...missing };
    return { ok: true, project, env, unchecked: deployIsUnchecked(facts), ctx };
  }

  /** Asks the providers whether the host has the commit, once in a while for the same environment and commit. */
  private async hostLacks(
    ctx: DeployContext,
    runs: readonly DeployRunStep[],
  ): Promise<{ kind: "unpushed" | "setup"; why: string } | undefined> {
    const key = `${ctx.project}:${ctx.env.env}:${ctx.commit}`;
    const seen = this.preflights.get(key);
    const at = this.deps.now().getTime();
    if (seen !== undefined && at - seen.at < PREFLIGHT_KEEP_MS) return seen.answer;
    let answer: { kind: "unpushed" | "setup"; why: string } | undefined;
    try {
      for (const step of runs) {
        const why = await this.deps.providers[step.kind].preflight(ctx, step);
        if (why !== undefined) {
          answer = { kind: "unpushed", why };
          break;
        }
      }
    } catch (err) {
      answer = { kind: "setup", why: reasonOf(err) };
    }
    this.preflights.set(key, { at, answer });
    return answer;
  }

  /**
   * Writes a task's plan: the ordered steps, as planned records that replace the task's planned ones. Nothing runs.
   * The rails are here, not in the captain's prompt: an environment the project has, no ssh run from the captain,
   * a task and projects of one workspace, a step once.
   */
  plan(input: PlanDeployInput, actor: DeployActor): Promise<PlanDeployResult> {
    return this.writePlan(input, actor);
  }

  private async writePlan(input: PlanDeployInput, actor: DeployActor): Promise<PlanDeployResult> {
    const task = this.deps.tasks.get(input.task);
    if (task === undefined) throw new UserError(`There is no task ${input.task}.`, 404);
    const org = task.org ?? PRIVATE;
    const seen = new Set<string>();
    for (const step of input.steps) {
      const project = await this.deps.projects.get(step.project).catch(() => undefined);
      if (project === undefined) throw new UserError(`There is no project ${step.project}.`, 404);
      if (project.org !== org) {
        throw new UserError(`${step.project} is not in the workspace of ${input.task}.`, 409);
      }
      if (!project.environments.some((e) => e.env === step.env)) {
        throw new UserError(
          `${step.project} has no ${step.env} environment. Its environments: ${project.environments.map((e) => e.env).join(", ") || "none"}.`,
          409,
        );
      }
      if (actor === "captain" && step.runs.some((r) => r.kind === "ssh")) {
        throw new UserError("An ssh run is the owner's: the captain does not plan one.", 409);
      }
      const key = `${step.project}:${step.env}`;
      if (seen.has(key)) throw new UserError(`${step.env} of ${step.project} is in the plan twice.`, 409);
      seen.add(key);
    }
    const at = this.deps.now().toISOString();
    // Steps that ran keep their place: the new ones come after them.
    const kept = this.deps.repo
      .ofTask(input.task)
      .filter((r) => r.state !== "planned" && !(r.state === "held" && !deployHasCommit(r)));
    const first = Math.max(0, ...kept.map((r) => r.seq)) + 1;
    const records = this.deps.repo.replacePlan(
      input.task,
      input.steps.map((step, i) => ({
        org,
        project: step.project,
        env: step.env,
        commit: plannedCommit(input.task, first + i),
        state: step.hold === undefined ? ("planned" as const) : ("held" as const),
        runs: step.runs,
        seq: first + i,
        ...(step.note === undefined ? {} : { note: step.note }),
        ...(step.hold === undefined ? {} : { reason: "Held for a migration: the owner lets it go" }),
        task: input.task,
        by: actor,
        at,
      })),
    );
    if (input.steps.length === 0) await this.deps.nothingDeploys?.(input.task, actor);
    this.changed();
    return { records };
  }

  /**
   * Deploys to an environment: a planned (or held, or failed) record by id, or the owner's own request. Returns the
   * record at once. The same environment and commit twice is one deploy: the second call returns the first's
   * record and starts nothing.
   */
  async deploy(input: DeployInput, actor: DeployActor, rest?: string): Promise<DeployResult> {
    const rec = "record" in input ? this.deps.repo.get(input.record) : undefined;
    if ("record" in input && rec === undefined) {
      throw new UserError(`There is no deploy ${input.record}.`, 404);
    }
    const req: DeployRequest =
      rec !== undefined
        ? {
            project: rec.project,
            env: rec.env,
            runs: rec.runs,
            record: rec,
            ...(rec.task === undefined ? {} : { task: rec.task }),
            ...(deployHasCommit(rec) ? { commit: rec.commit } : {}),
            confirmUnchecked: input.confirmUnchecked === true,
          }
        : "record" in input
          ? (() => {
              throw new UserError("There is no such deploy.", 404);
            })()
          : { ...input, confirmUnchecked: input.confirmUnchecked === true };
    const retry = input.retry === true;
    const named =
      rec !== undefined
        ? rec
        : req.commit === undefined
          ? undefined
          : this.deps.repo.find(req.project, req.env, req.commit);
    // A record of this commit that is moving or live is the answer: nothing about it is decided again.
    if (named !== undefined && (deployIsActive(named.state) || named.state === "live")) {
      return { record: named, repeat: true };
    }
    // Failed or rolled back, and nobody asked to try again: the captain never retries a deploy by itself.
    if (
      rec !== undefined &&
      (rec.state === "failed" || rec.state === "rolled-back") &&
      !(retry && actor === "owner")
    ) {
      return { record: rec, repeat: true };
    }
    const evaluated = await this.evaluate(req, actor, rest);
    if (!evaluated.ok) throw new UserError(evaluated.why, 409);
    const { ctx, project, env } = evaluated;
    const existing = this.deps.repo.find(project.id, env.env, ctx.commit);
    const at = this.deps.now().toISOString();
    const carried = {
      by: actor,
      ...(req.task === undefined ? {} : { task: req.task }),
      ...(evaluated.unchecked ? { unchecked: true } : {}),
    };
    let record: DeployRecord | undefined;
    if (rec !== undefined && existing !== undefined && existing.id !== rec.id) {
      // Another record already has this environment and commit (another task shipped the same head): that one is
      // the answer, and the step that was only planned is moot.
      if (!deployHasCommit(rec)) this.deps.repo.dropUnstarted(rec.id);
      // The same head already failed here and the owner asks again: that is a retry of the failed record.
      const again =
        retry && actor === "owner" && (existing.state === "failed" || existing.state === "rolled-back")
          ? this.deps.repo.move(existing.id, existing.state, "queued", at, { ...carried, runs: req.runs })
          : undefined;
      if (again !== undefined) {
        this.audit(again, true, `Started by ${actor}`);
        this.changed();
        this.kick(again.id);
        return { record: again, repeat: false };
      }
      this.changed();
      return { record: existing, repeat: true };
    }
    if (rec !== undefined) {
      const stand = deployHasCommit(rec) ? {} : { commit: ctx.commit };
      if (rec.state === "failed" || rec.state === "rolled-back") {
        record = this.deps.repo.move(rec.id, rec.state, "queued", at, carried);
      } else if (rec.state === "planned" || rec.state === "held") {
        record = this.deps.repo.move(rec.id, rec.state, "queued", at, { ...carried, ...stand });
      }
    } else if (existing === undefined) {
      record = this.deps.repo.create({
        org: project.org,
        project: project.id,
        env: env.env,
        commit: ctx.commit,
        state: "queued",
        runs: req.runs,
        at,
        ...carried,
      });
    } else if (deployIsActive(existing.state) || existing.state === "live") {
      return { record: existing, repeat: true };
    } else if (existing.state === "held") {
      record = this.deps.repo.move(existing.id, "held", "queued", at, {
        ...carried,
        ...(existing.runs.length === 0 ? { runs: req.runs } : {}),
      });
    } else if (retry && actor === "owner") {
      record = this.deps.repo.move(existing.id, existing.state, "queued", at, {
        ...carried,
        runs: req.runs,
      });
    } else {
      return { record: existing, repeat: true };
    }
    if (record === undefined) {
      // Another caller made or moved it first: its record is the answer.
      const winner = this.deps.repo.find(project.id, env.env, ctx.commit);
      if (winner === undefined) throw new Error("A deploy record vanished");
      return { record: winner, repeat: true };
    }
    this.audit(record, true, `Started by ${actor}`);
    this.changed();
    this.kick(record.id);
    return { record, repeat: false };
  }

  /** The owner said hold: no rule deploys this step or commit until the owner does it. */
  async hold(input: z.infer<typeof DeployHoldInputSchema>): Promise<DeployRecord> {
    const at = this.deps.now().toISOString();
    if ("record" in input) {
      const rec = this.deps.repo.get(input.record);
      if (rec === undefined) throw new UserError(`There is no deploy ${input.record}.`, 404);
      if (rec.state === "held") return rec;
      if (rec.state !== "planned" && rec.state !== "queued") {
        throw new UserError(`Deploy ${rec.id} is ${rec.state}, so it cannot be held.`, 409);
      }
      const held = this.deps.repo.move(rec.id, rec.state, "held", at, { reason: "You held it", by: "owner" });
      if (held === undefined) throw new UserError(`Deploy ${rec.id} changed while it was held.`, 409);
      this.changed();
      return held;
    }
    const existing = this.deps.repo.find(input.project, input.env, input.commit);
    if (existing !== undefined) return existing;
    const project = await this.deps.projects.get(input.project);
    if (!project.environments.some((e) => e.env === input.env)) {
      throw new UserError(`${project.id} has no ${input.env} environment.`);
    }
    const record = this.deps.repo.create({
      org: project.org,
      project: project.id,
      env: input.env,
      commit: input.commit,
      state: "held",
      runs: input.runs ?? [],
      by: "owner",
      reason: "You held it",
      at,
      ...(input.task === undefined ? {} : { task: input.task }),
    });
    const made = record ?? this.deps.repo.find(input.project, input.env, input.commit);
    if (made === undefined) throw new Error("A deploy record vanished");
    this.changed();
    return made;
  }

  /**
   * Goes back: runs the runs of the environment's earlier live deploy again, for a deploy that is live or whose
   * own rollback did not work. The owner's click, and what the captain log offers instead of Undo.
   */
  async rollback(id: number, actor: DeployActor): Promise<DeployResult> {
    const record = this.deps.repo.get(id);
    if (record === undefined) throw new UserError(`There is no deploy ${id}.`, 404);
    if (record.state === "rolled-back") return { record, repeat: true };
    if (record.state !== "live" && record.state !== "failed") {
      throw new UserError(
        `Deploy ${id} is ${record.state}. Only a live or a failed deploy can be rolled back.`,
        409,
      );
    }
    if (record.state === "live" && this.deps.repo.latestLive(record.project, record.env)?.id !== record.id) {
      throw new UserError(`A newer deploy of ${record.env} is live. Roll that one back.`, 409);
    }
    if (this.rollingBack.has(id)) return { record, repeat: true };
    this.rollingBack.add(id);
    this.changed();
    try {
      const done = await this.goBack(record);
      this.audit(record, done.ok, `Rolled back by ${actor}: ${done.detail}`);
      const at = this.deps.now().toISOString();
      const moved = done.ok
        ? this.deps.repo.move(record.id, record.state, "rolled-back", at, { rollback: done, finished: true })
        : this.deps.repo.annotate(record.id, at, { rollback: done });
      this.changed();
      if (moved === undefined) throw new UserError(`Deploy ${id} changed while it was rolled back.`, 409);
      if (!done.ok) throw new UserError(`The rollback did not work: ${done.detail}`, 409);
      return { record: moved, repeat: false };
    } finally {
      this.rollingBack.delete(id);
    }
  }

  /** The deploys whose rollback is running now. */
  rollingBackIds(): number[] {
    return [...this.rollingBack];
  }

  /** Calls `listener` whenever a deploy record changes. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** A project's deploys, newest first. */
  history(project: string, limit = 30): DeployRecord[] {
    return this.deps.repo.ofProject(project, limit);
  }

  /** Follows every deploy that was moving when majhi stopped. */
  resume(): void {
    for (const record of this.deps.repo.active()) this.kick(record.id);
  }

  /** Resolves when no deploy is being followed: for tests and a clean shutdown. */
  async idle(): Promise<void> {
    while (this.flying.size > 0) await Promise.all([...this.flying]);
  }

  // ---------------------------------------------------------------------------
  // Following a deploy

  private kick(id: number): void {
    const record = this.deps.repo.get(id);
    if (record === undefined) return;
    // One at a time per environment: a newer commit waits for the one that is going out.
    const lane = `${record.project}:${record.env}`;
    const before = this.lanes.get(lane) ?? Promise.resolve();
    const next: Promise<void> = before
      .then(() => this.drive(id))
      .catch((err: unknown) => this.crashed(id, err));
    this.lanes.set(lane, next);
    this.flying.add(next);
    void next.finally(() => {
      this.flying.delete(next);
      if (this.lanes.get(lane) === next) this.lanes.delete(lane);
    });
  }

  private async drive(id: number): Promise<void> {
    let record = this.deps.repo.get(id);
    let resumed = true;
    if (record?.state === "queued") {
      record = this.begin(record);
      resumed = false;
    }
    if (record?.state === "running") record = await this.follow(record, resumed);
    if (record?.state === "verifying") await this.check(record);
  }

  /** The follow itself broke (a bug, a full disk): the record must not stay moving for ever. */
  private async crashed(id: number, err: unknown): Promise<void> {
    const record = this.deps.repo.get(id);
    if (record === undefined || !deployIsActive(record.state)) return;
    await this.fail(record, `majhi could not follow the deploy: ${reasonOf(err)}`, { rollback: true }).catch(
      () => undefined,
    );
  }

  private async contextOf(record: DeployRecord): Promise<DeployContext | undefined> {
    const project = await this.deps.projects.get(record.project).catch(() => undefined);
    const env = project?.environments.find((e) => e.env === record.env);
    if (project === undefined || env === undefined || project.base === undefined) return undefined;
    return this.contextFor(project, env, record.commit, project.base);
  }

  /** queued to running: what the environment ran before is noted, for a rollback. */
  private begin(record: DeployRecord): DeployRecord | undefined {
    const at = this.deps.now().toISOString();
    const previous = this.deps.repo.latestLive(record.project, record.env)?.commit;
    const running = this.deps.repo.move(record.id, "queued", "running", at, {
      ...(previous === undefined ? {} : { previous }),
    });
    if (running !== undefined) this.changed();
    return running;
  }

  /**
   * Starts the record's runs one after the other, and waits for each to end: running to verifying, or to failed.
   * A run that was started and not ended (a restart in between) is followed, not started again.
   */
  private async follow(record: DeployRecord, resumed: boolean): Promise<DeployRecord | undefined> {
    const ctx = await this.contextOf(record);
    if (ctx === undefined) {
      return this.fail(record, "The environment is not in the project any more.", { rollback: false });
    }
    if (record.runs.length === 0) {
      return this.fail(record, "The deploy has no runs to start.", { rollback: false });
    }
    const handles = [...record.handles];
    for (const [i, step] of record.runs.entries()) {
      const provider = this.deps.providers[step.kind];
      let handle: RunHandle | undefined = handles[i];
      if (handle?.ended === true) continue;
      let outcome: RunHandle["outcome"];
      if (handle === undefined) {
        if (resumed) {
          return this.fail(record, "majhi restarted before the run was known, so what it did is not known", {
            rollback: true,
          });
        }
        try {
          const refused = await provider.preflight(ctx, step);
          // Nothing was deployed yet when the first run is refused or does not start, so there is nothing to roll back.
          if (refused !== undefined) return this.fail(record, refused, { rollback: i > 0 });
          const started = await provider.start(ctx, step);
          outcome = started.outcome;
          const { outcome: _over, ...run } = started;
          handle = run;
          handles[i] = run;
          this.deps.repo.annotate(record.id, this.deps.now().toISOString(), { handles });
          this.changed();
        } catch (err) {
          return this.fail(record, reasonOf(err), { rollback: i > 0 });
        }
      }
      const ended =
        outcome === undefined ? await this.waitFor(provider, ctx, step, handle) : progressOf(outcome);
      if (!ended.ok) return this.fail(record, ended.detail, { rollback: true });
      handles[i] = { ...handle, ended: true };
      this.deps.repo.annotate(record.id, this.deps.now().toISOString(), { handles });
      this.changed();
    }
    const verifying = this.deps.repo.move(record.id, "running", "verifying", this.deps.now().toISOString());
    this.changed();
    return verifying;
  }

  /** Looks at a run until it succeeds, fails or takes too long. */
  private async waitFor(
    provider: DeployProvider,
    ctx: DeployContext,
    step: DeployRunStep,
    run: RunHandle,
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    const deadline = this.deps.now().getTime() + this.deps.runTimeoutMs;
    let errors = 0;
    for (;;) {
      try {
        const progress = await provider.poll(ctx, step, run);
        errors = 0;
        if (progress.state === "success") return { ok: true };
        if (progress.state === "failed") return { ok: false, detail: progress.detail };
      } catch (err) {
        if (++errors >= MAX_POLL_ERRORS) return { ok: false, detail: reasonOf(err) };
      }
      if (this.deps.now().getTime() >= deadline) {
        return {
          ok: false,
          detail: `The run did not end within ${Math.round(this.deps.runTimeoutMs / 60_000)} minutes`,
        };
      }
      await this.deps.sleep(this.deps.pollMs);
    }
  }

  /** The check after the runs: verifying to live, or to failed. */
  private async check(record: DeployRecord): Promise<void> {
    const ctx = await this.contextOf(record);
    if (ctx === undefined) {
      await this.fail(record, "The environment is not in the project any more.", { rollback: false });
      return;
    }
    const result = await this.verify(ctx);
    const at = this.deps.now().toISOString();
    const check = { ok: result.ok, detail: result.detail, at };
    if (!result.ok) {
      await this.fail(record, result.detail, { rollback: true, check });
      return;
    }
    const live = this.deps.repo.move(record.id, "verifying", "live", at, { check, finished: true });
    if (live === undefined) return;
    this.audit(live, true, `Live: ${result.detail}`);
    this.changed();
    if (live.task !== undefined) {
      this.deps.taskNote?.(
        live.task,
        `deploy:${live.id}:live`,
        "info",
        `${live.env} is live at ${live.commit.slice(0, 7)}. ${result.detail}.`,
      );
    }
    this.deps.onLive?.(live);
  }

  private verify(ctx: DeployContext): Promise<{ ok: boolean; detail: string }> {
    return verifyDeploy(
      { health: ctx.env.check, waitSeconds: this.deps.checkSeconds },
      {
        health: this.deps.looks.health,
        sleep: (ms) => this.deps.sleep(ms),
        now: () => this.deps.now().getTime(),
        everyMs: this.deps.verifyMs,
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Failure and rollback

  /**
   * The run or the check failed. Rolls back at once when something was deployed, opens an incident task with
   * what was seen, and tells the owner. Never silent.
   */
  private async fail(
    record: DeployRecord,
    reason: string,
    opts: { rollback: boolean; check?: DeployRecord["check"] },
  ): Promise<undefined> {
    const at = this.deps.now().toISOString();
    const failed = this.deps.repo.move(
      record.id,
      record.state as "queued" | "running" | "verifying",
      "failed",
      at,
      {
        reason,
        finished: true,
        ...(opts.check === undefined ? {} : { check: opts.check }),
      },
    );
    if (failed === undefined) return undefined;
    this.audit(failed, false, reason);
    this.changed();
    let current = failed;
    if (opts.rollback) {
      this.rollingBack.add(failed.id);
      this.changed();
      const done = await this.goBack(failed)
        .catch((err: unknown) => ({
          ok: false,
          detail: reasonOf(err),
          at: this.deps.now().toISOString(),
        }))
        .finally(() => this.rollingBack.delete(failed.id));
      const when = this.deps.now().toISOString();
      current =
        (done.ok
          ? this.deps.repo.move(failed.id, "failed", "rolled-back", when, { rollback: done })
          : this.deps.repo.annotate(failed.id, when, { rollback: done })) ?? failed;
      this.audit(current, done.ok, `Rollback: ${done.detail}`);
      this.changed();
    }
    const brief = incidentBrief({ record: current, log: opts.check?.detail ?? reason });
    const incident = await this.deps
      .openIncident({ org: current.org, project: current.project, record: current, ...brief })
      .catch(() => undefined);
    if (incident !== undefined) {
      current = this.deps.repo.annotate(current.id, this.deps.now().toISOString(), { incident }) ?? current;
      this.changed();
    }
    const line = tellLine(current, reason);
    this.deps.tellOwner(current.org, `deploy:${current.id}:failed`, line);
    if (current.task !== undefined) {
      this.deps.taskNote?.(current.task, `deploy:${current.id}:failed`, "warn", line);
    }
    return undefined;
  }

  /**
   * Runs the runs of the environment's earlier live deploy again, each at that deploy's commit with its own inputs,
   * and checks the environment is healthy again. A deploy whose runs cannot be repeated says so.
   */
  private async goBack(record: DeployRecord): Promise<NonNullable<DeployRecord["rollback"]>> {
    const ctx = await this.contextOf(record);
    const at = () => this.deps.now().toISOString();
    if (ctx === undefined) {
      return { ok: false, detail: "The environment is not in the project any more.", at: at() };
    }
    const earlier =
      record.previous === undefined
        ? undefined
        : this.deps.repo.find(record.project, record.env, record.previous);
    if (earlier === undefined) {
      return { ok: false, detail: "There is no earlier deploy of this environment to go back to.", at: at() };
    }
    if (earlier.runs.length === 0) {
      return {
        ok: false,
        detail: `The earlier deploy (${earlier.commit.slice(0, 7)}) has no recorded runs, so majhi cannot repeat it. Ask the owner to roll ${record.env} back by hand.`,
        at: at(),
      };
    }
    const stuck = earlier.runs.find((step) => this.deps.providers[step.kind].redeploy === undefined);
    if (stuck !== undefined) {
      return {
        ok: false,
        detail: `A ${stuck.kind} run cannot go back to an earlier commit, so majhi cannot repeat the deploy of ${earlier.commit.slice(0, 7)}. Ask the owner to roll ${record.env} back by hand.`,
        at: at(),
      };
    }
    const back = { ...ctx, commit: earlier.commit };
    let last: RunHandle | undefined;
    for (const [i, step] of earlier.runs.entries()) {
      const redeploy = this.deps.providers[step.kind].redeploy;
      if (redeploy === undefined) continue;
      let handle: RunHandle;
      try {
        handle = await redeploy.call(this.deps.providers[step.kind], back, step, {
          commit: earlier.commit,
          run: earlier.handles[i],
        });
      } catch (err) {
        if (!(err instanceof DeployProblem)) throw err;
        return {
          ok: false,
          detail: `${err.message} Ask the owner to roll ${record.env} back by hand.`,
          at: at(),
        };
      }
      last = handle;
      const ended =
        handle.outcome !== undefined
          ? progressOf(handle.outcome)
          : await this.waitFor(this.deps.providers[step.kind], back, step, handle);
      if (!ended.ok) return { ok: false, detail: ended.detail, run: handle, at: at() };
    }
    const checked = await this.verify(ctx);
    return {
      ok: checked.ok,
      detail: checked.ok ? checked.detail : `Rolled back, but the check still fails: ${checked.detail}`,
      commit: earlier.commit,
      ...(last === undefined ? {} : { run: last }),
      at: at(),
    };
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
    this.deps.changed();
  }

  private audit(record: DeployRecord, ok: boolean, detail: string): void {
    this.deps.audit({
      org: record.org,
      task: record.task ?? "",
      by: record.by,
      ok,
      title: `Deploy ${record.env} of ${record.project}`,
      detail: `${record.commit.slice(0, 7)}, deploy ${record.id}${record.run?.url === undefined ? "" : `, ${record.run.url}`}: ${detail}`,
    });
  }
}

function progressOf(p: { state: "running" } | { state: "success" } | { state: "failed"; detail: string }) {
  return p.state === "success"
    ? ({ ok: true } as const)
    : ({ ok: false, detail: p.state === "failed" ? p.detail : "The command did not end." } as const);
}

/** What the owner is told when a deploy failed. */
function tellLine(record: DeployRecord, reason: string): string {
  const where = `${record.project} to ${record.env}`;
  const rolled =
    record.rollback === undefined
      ? "Nothing was deployed, so nothing was rolled back."
      : record.rollback.ok
        ? `${record.env} is back${record.rollback.commit === undefined ? "" : ` at ${record.rollback.commit.slice(0, 7)}`}.`
        : `The rollback did not work (${record.rollback.detail}), so ${record.env} may be broken.`;
  const incident = record.incident === undefined ? "" : ` Incident ${record.incident} is open.`;
  return `Deploy of ${where} failed: ${reason.split("\n")[0]}. ${rolled}${incident}`;
}
