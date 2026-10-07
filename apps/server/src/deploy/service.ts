import {
  type DeployInput,
  type DeployRecord,
  type DeployResult,
  type DeployTarget,
  deployIsActive,
  PRIVATE,
  type RemoteConfig,
} from "@majhi/shared";
import { errorMessage, UserError } from "../errors.ts";
import type { DeployRepo } from "../store/deploys.ts";
import type { DeployGit } from "./git.ts";
import { deployIsUnchecked, deployRefusal, rollbackProblem, targetsBefore } from "./guards.ts";
import { incidentBrief } from "./incident.ts";
import { runRollbackCommand } from "./ssh.ts";
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
 * Deploys (docs/design/ship-without-me.md, section 3). `deploy` decides whether a deploy may start, makes
 * the one record for the target and commit, and returns at once; the run is followed in the background
 * until it ends, then checked. A failed run or check rolls back, opens an incident task and tells the owner.
 *
 * Every step is keyed by the record: asking again for the same target and commit finds the record, so a
 * deploy is never started twice, and a restart picks up the records that were moving.
 */

export interface DeployProject {
  id: string;
  org: string;
  path: string;
  base: string | undefined;
  remotes: Readonly<Record<string, RemoteConfig>>;
  targets: readonly DeployTarget[];
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
  /** The project's host and repo, from its remote. Undefined when the remote is not a host a provider reaches. */
  repoRef(project: DeployProject): Promise<RepoRef | undefined>;
  /** The project's card sets a test, build or lint command, so a commit no merge produced is unverified. */
  checksConfigured(project: string): boolean;
  providers: Providers;
  providerDeps: ProviderDeps;
  /** One look at a health address, and at a watch of the workspace. */
  looks: Pick<VerifyDeps, "health"> & {
    watch(org: string, id: string): Promise<{ ok: boolean; detail: string }>;
  };
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
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Time between looks at a run, and between looks of the check. */
  pollMs: number;
  verifyMs: number;
  /** A run that has not ended by then failed. */
  runTimeoutMs: number;
}

export type DeployActor = DeployRecord["by"];

/** What a decision to deploy says before anything starts: the sentence that stops it, or what it would run with. */
export type Evaluated =
  | { ok: false; why: string }
  | { ok: true; project: DeployProject; target: DeployTarget; ctx: DeployContext; unchecked: boolean };

/** Calls to a provider that fail this many times in a row end the follow: what the run did is not known. */
const MAX_POLL_ERRORS = 5;

const reasonOf = (err: unknown): string => {
  const text = err instanceof DeployProblem ? err.message : errorMessage(err);
  return text.length > 600 ? `${text.slice(0, 599)}…` : text;
};

export class DeployService {
  private readonly flying = new Set<Promise<void>>();
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly rollingBack = new Set<number>();

  constructor(private readonly deps: DeployDeps) {}

  /** Why a deploy of the commit to the target may not start, or what it would run with. Starts nothing. */
  async evaluate(input: DeployInput, actor: DeployActor, rest?: string): Promise<Evaluated> {
    const project = await this.deps.projects.get(input.project);
    const target = project.targets.find((t) => t.env === input.env);
    if (target === undefined) return { ok: false, why: `${project.id} has no ${input.env} target.` };
    if (input.task !== undefined) {
      const task = this.deps.tasks.get(input.task);
      if ((task?.org ?? PRIVATE) !== project.org) {
        return { ok: false, why: `${input.task} is not in the workspace of ${project.id}.` };
      }
    }
    const base = project.base;
    if (base === undefined) return { ok: false, why: `${project.id} has no base branch.` };
    const tip = await this.deps.git.tip(project.path, base);
    const commit = input.commit ?? tip;
    if (commit === undefined) return { ok: false, why: "majhi could not read the project's base branch." };
    const facts = {
      actor,
      commit,
      tip,
      landed: this.deps.tasks.landedCommits(project.id).has(commit),
      checksConfigured: this.deps.checksConfigured(project.id),
      confirmUnchecked: input.confirmUnchecked === true,
      before: targetsBefore(project.targets, target.env).map((env) => ({
        env,
        live: this.deps.repo.find(project.id, env, commit)?.state === "live",
      })),
      rest,
    };
    const why = deployRefusal(facts);
    if (why !== undefined) return { ok: false, why };
    return {
      ok: true,
      project,
      target,
      unchecked: deployIsUnchecked(facts),
      ctx: {
        org: project.org,
        project: project.id,
        env: target.env,
        base,
        commit,
        repo: await this.deps.repoRef(project),
        target,
      },
    };
  }

  /**
   * Deploys a commit of a project to one of its targets. Returns the record at once. The same target
   * and commit twice is one deploy: the second call returns the first's record and starts nothing.
   */
  async deploy(input: DeployInput, actor: DeployActor, rest?: string): Promise<DeployResult> {
    const named =
      input.commit === undefined ? undefined : this.deps.repo.find(input.project, input.env, input.commit);
    // A record of this commit that is moving or live is the answer: nothing about it is decided again.
    if (named !== undefined && (deployIsActive(named.state) || named.state === "live")) {
      return { record: named, repeat: true };
    }
    const evaluated = await this.evaluate(input, actor, rest);
    if (!evaluated.ok) throw new UserError(evaluated.why, 409);
    const { ctx, target, project } = evaluated;
    const existing = this.deps.repo.find(project.id, target.env, ctx.commit);
    const at = this.deps.now().toISOString();
    const carried = {
      by: actor,
      ...(input.task === undefined ? {} : { task: input.task }),
      ...(evaluated.unchecked ? { unchecked: true } : {}),
    };
    let record: DeployRecord | undefined;
    if (existing === undefined) {
      record = this.deps.repo.create({
        org: project.org,
        project: project.id,
        env: target.env,
        commit: ctx.commit,
        state: "queued",
        at,
        ...carried,
      });
    } else if (deployIsActive(existing.state) || existing.state === "live") {
      return { record: existing, repeat: true };
    } else if (existing.state === "held") {
      record = this.deps.repo.move(existing.id, "held", "queued", at, carried);
    } else if (input.retry === true && actor === "owner") {
      record = this.deps.repo.move(existing.id, existing.state, "queued", at, carried);
    } else {
      // Failed or rolled back, and nobody asked to try again: the captain never retries a deploy by itself.
      return { record: existing, repeat: true };
    }
    if (record === undefined) {
      // Another caller made or moved it first: its record is the answer.
      const winner = this.deps.repo.find(project.id, target.env, ctx.commit);
      if (winner === undefined) throw new Error("A deploy record vanished");
      return { record: winner, repeat: true };
    }
    this.audit(record, true, `Started by ${actor}`);
    this.deps.changed();
    this.kick(record.id);
    return { record, repeat: false };
  }

  /** The owner said hold: no rule deploys this commit to this target until the owner does it. */
  async hold(input: {
    project: string;
    env: string;
    commit: string;
    task?: string | undefined;
  }): Promise<DeployRecord> {
    const existing = this.deps.repo.find(input.project, input.env, input.commit);
    if (existing !== undefined) return existing;
    const project = await this.deps.projects.get(input.project);
    if (!project.targets.some((t) => t.env === input.env)) {
      throw new UserError(`${project.id} has no ${input.env} target.`);
    }
    const record = this.deps.repo.create({
      org: project.org,
      project: project.id,
      env: input.env,
      commit: input.commit,
      state: "held",
      by: "owner",
      reason: "You held it",
      at: this.deps.now().toISOString(),
      ...(input.task === undefined ? {} : { task: input.task }),
    });
    const made = record ?? this.deps.repo.find(input.project, input.env, input.commit);
    if (made === undefined) throw new Error("A deploy record vanished");
    this.deps.changed();
    return made;
  }

  /**
   * Goes back: runs the target's rollback for a deploy that is live or whose own rollback did not work.
   * The owner's click, and what the captain log offers instead of Undo.
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
    try {
      const done = await this.goBack(record);
      this.audit(record, done.ok, `Rolled back by ${actor}: ${done.detail}`);
      const at = this.deps.now().toISOString();
      const moved = done.ok
        ? this.deps.repo.move(record.id, record.state, "rolled-back", at, { rollback: done, finished: true })
        : this.deps.repo.annotate(record.id, at, { rollback: done });
      this.deps.changed();
      if (moved === undefined) throw new UserError(`Deploy ${id} changed while it was rolled back.`, 409);
      if (!done.ok) throw new UserError(`The rollback did not work: ${done.detail}`, 409);
      return { record: moved, repeat: false };
    } finally {
      this.rollingBack.delete(id);
    }
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
    // One at a time per target: a newer commit waits for the one that is going out.
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
    let handle: RunHandle | undefined;
    if (record?.state === "queued") ({ record, handle } = await this.begin(record));
    if (record?.state === "running") record = await this.follow(record, handle);
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

  private async contextOf(
    record: DeployRecord,
  ): Promise<{ ctx: DeployContext; provider: DeployProvider } | undefined> {
    const project = await this.deps.projects.get(record.project).catch(() => undefined);
    const target = project?.targets.find((t) => t.env === record.env);
    if (project === undefined || target === undefined || project.base === undefined) return undefined;
    return {
      ctx: {
        org: project.org,
        project: project.id,
        env: target.env,
        base: project.base,
        commit: record.commit,
        repo: await this.deps.repoRef(project),
        target,
      },
      provider: this.deps.providers[target.via.kind],
    };
  }

  /** queued to running: the run is started. The handle is what the provider returned, with an outcome when the run is already over. */
  private async begin(
    record: DeployRecord,
  ): Promise<{ record: DeployRecord | undefined; handle?: RunHandle }> {
    const at = this.deps.now().toISOString();
    const previous = this.deps.repo.latestLive(record.project, record.env)?.commit;
    const running = this.deps.repo.move(record.id, "queued", "running", at, {
      ...(previous === undefined ? {} : { previous }),
    });
    if (running === undefined) return { record: undefined };
    this.deps.changed();
    const known = await this.contextOf(running);
    if (known === undefined) {
      return {
        record: await this.fail(running, "The target is not in the project any more.", { rollback: false }),
      };
    }
    try {
      const refused = await known.provider.preflight(known.ctx);
      if (refused !== undefined) return { record: await this.fail(running, refused, { rollback: false }) };
      const handle = await known.provider.start(known.ctx);
      const { outcome: _over, ...run } = handle;
      this.deps.repo.annotate(running.id, this.deps.now().toISOString(), { run });
      this.deps.changed();
      return { record: this.deps.repo.get(running.id), handle };
    } catch (err) {
      // Nothing was deployed, so there is nothing to roll back.
      return { record: await this.fail(running, reasonOf(err), { rollback: false }) };
    }
  }

  /** Waits for the run to end: running to verifying, or to failed. */
  private async follow(record: DeployRecord, started?: RunHandle): Promise<DeployRecord | undefined> {
    const known = await this.contextOf(record);
    if (known === undefined)
      return this.fail(record, "The target is not in the project any more.", { rollback: false });
    const run: RunHandle | undefined = started ?? record.run;
    if (run === undefined) {
      return this.fail(record, "majhi restarted before the run was known, so what it did is not known", {
        rollback: true,
      });
    }
    const ended =
      run.outcome === undefined
        ? await this.waitFor(known.provider, known.ctx, run)
        : progressOf(run.outcome);
    if (!ended.ok) return this.fail(record, ended.detail, { rollback: true });
    const verifying = this.deps.repo.move(record.id, "running", "verifying", this.deps.now().toISOString());
    this.deps.changed();
    return verifying;
  }

  /** Looks at a run until it succeeds, fails or takes too long. */
  private async waitFor(
    provider: DeployProvider,
    ctx: DeployContext,
    run: RunHandle,
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    const deadline = this.deps.now().getTime() + this.deps.runTimeoutMs;
    let errors = 0;
    for (;;) {
      try {
        const progress = await provider.poll(ctx, run);
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

  /** The check after the run: verifying to live, or to failed. */
  private async check(record: DeployRecord): Promise<void> {
    const known = await this.contextOf(record);
    if (known === undefined) {
      await this.fail(record, "The target is not in the project any more.", { rollback: false });
      return;
    }
    const result = await this.verify(known.ctx);
    const at = this.deps.now().toISOString();
    const check = { ok: result.ok, detail: result.detail, at };
    if (!result.ok) {
      await this.fail(record, result.detail, { rollback: true, check });
      return;
    }
    const live = this.deps.repo.move(record.id, "verifying", "live", at, { check, finished: true });
    if (live === undefined) return;
    this.audit(live, true, `Live: ${result.detail}`);
    this.deps.changed();
  }

  private verify(ctx: DeployContext): Promise<{ ok: boolean; detail: string }> {
    return verifyDeploy(ctx.target.verify, {
      health: this.deps.looks.health,
      watch: (id) => this.deps.looks.watch(ctx.org, id),
      sleep: (ms) => this.deps.sleep(ms),
      now: () => this.deps.now().getTime(),
      everyMs: this.deps.verifyMs,
    });
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
    this.deps.changed();
    let current = failed;
    if (opts.rollback) {
      const done = await this.goBack(failed).catch((err: unknown) => ({
        ok: false,
        detail: reasonOf(err),
        at: this.deps.now().toISOString(),
      }));
      const when = this.deps.now().toISOString();
      current =
        (done.ok
          ? this.deps.repo.move(failed.id, "failed", "rolled-back", when, { rollback: done })
          : this.deps.repo.annotate(failed.id, when, { rollback: done })) ?? failed;
      this.audit(current, done.ok, `Rollback: ${done.detail}`);
      this.deps.changed();
    }
    const brief = incidentBrief({ record: current, log: opts.check?.detail ?? reason });
    const incident = await this.deps
      .openIncident({ org: current.org, project: current.project, record: current, ...brief })
      .catch(() => undefined);
    if (incident !== undefined) {
      current = this.deps.repo.annotate(current.id, this.deps.now().toISOString(), { incident }) ?? current;
      this.deps.changed();
    }
    this.deps.tellOwner(current.org, `deploy:${current.id}:failed`, tellLine(current, reason));
    return undefined;
  }

  /** Runs the target's rollback and checks the target is healthy again. */
  private async goBack(record: DeployRecord): Promise<NonNullable<DeployRecord["rollback"]>> {
    const known = await this.contextOf(record);
    const at = () => this.deps.now().toISOString();
    if (known === undefined)
      return { ok: false, detail: "The target is not in the project any more.", at: at() };
    const { ctx, provider } = known;
    const how = ctx.target.rollback;
    const problem = rollbackProblem(ctx.target);
    if (problem !== undefined) return { ok: false, detail: problem, at: at() };
    let handle: RunHandle;
    if (how.kind === "ssh") {
      handle = await runRollbackCommand(ctx, this.deps.providerDeps, how.connection, how.command);
    } else {
      if (record.previous === undefined || provider.redeploy === undefined) {
        return { ok: false, detail: "There is no earlier deploy of this target to go back to.", at: at() };
      }
      const before = this.deps.repo.find(record.project, record.env, record.previous);
      handle = await provider.redeploy(
        { ...ctx, commit: record.previous },
        { commit: record.previous, run: before?.run },
      );
    }
    const ended =
      handle.outcome !== undefined ? progressOf(handle.outcome) : await this.waitFor(provider, ctx, handle);
    if (!ended.ok) return { ok: false, detail: ended.detail, run: handle, at: at() };
    const checked = await this.verify(ctx);
    const commit = how.kind === "redeploy-previous" ? record.previous : undefined;
    return {
      ok: checked.ok,
      detail: checked.ok ? checked.detail : `Rolled back, but the check still fails: ${checked.detail}`,
      ...(commit === undefined ? {} : { commit }),
      run: handle,
      at: at(),
    };
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
