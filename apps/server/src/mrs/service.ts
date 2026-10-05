import { randomUUID } from "node:crypto";
import {
  DEFAULT_MERGE_POLICY,
  type GitAuth,
  type MarkMergedResult,
  type MergeMethod,
  type MergeMrsResult,
  type MergeOrder,
  type MergePolicy,
  type MrHost,
  type OpenMrsResult,
  type ProjectLink,
  type RefreshMrsResult,
  type RemoteConfig,
  type RepoMr,
  type ShipFix,
  type ShipOption,
  type ShipOptions,
  type Task,
  type TaskRepo,
  waitsForOwner,
} from "@majhi/shared";
import { logShip } from "../audit.ts";
import type { ConfigService } from "../config/service.ts";
import { errorMessage, UserError } from "../errors.ts";
import type { EventHub } from "../events/hub.ts";
import { type FastForwardOutcome, fastForwardBranch } from "../git/fast-forward.ts";
import { FETCH_TIMEOUT_MS, git, gitOk, localBranchExists, uncommitted } from "../git/git.ts";
import type { GitLoginService } from "../git/logins.ts";
import { isSshAuthFailure, removeWorktree } from "../git/worktrees.ts";
import type { ProjectInfo, ProjectService } from "../projects/service.ts";
import type { RoomService } from "../room/service.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { Store } from "../store/index.ts";
import { inferBranchType, readRepoStyle, titleFor, typeOfBranch } from "../tasks/branch-naming.ts";
import type { TaskService } from "../tasks/service.ts";
import {
  HELD,
  heldResult,
  NO_CHANGES,
  planTargets,
  type ShipTargets,
  skippedResult,
  splitChanged,
  targetsFor,
} from "../tasks/ship-plan.ts";
import { renderMrDescription } from "./description.ts";
import type { HostGit } from "./hostGit.ts";
import type { MrHostClient, MrTarget } from "./hosts/index.ts";
import { MergeOrderCycle, mergeOrder, orderViolations, type ProjectGraph } from "./order.ts";
import { nextMerge, type RepoMrState } from "./policy.ts";
import { commitsAhead, PushProblem, pushBranch, remoteHasTip, remoteUrl } from "./push.ts";
import { hostNameOf, mrHostOf, mrRemoteName, repoSlug, rewriteRemoteUrl } from "./remote.ts";
import {
  chooseRoute,
  describeLogin,
  httpsPushUrl,
  httpsToSsh,
  loginsOf,
  ownerOf,
  type PushRoute,
} from "./route.ts";
import { ShipQueue } from "./ship-queue.ts";

export interface MrDeps {
  /** Which accounts the owner's keys log in as per git host. Without it https remotes need an alias. */
  gitLogins?: Pick<GitLoginService, "list">;
  store: Store;
  config: ConfigService;
  projects: ProjectService;
  secrets: SecretStore;
  room: RoomService;
  events: EventHub;
  tasks: Pick<
    TaskService,
    | "get"
    | "close"
    | "closeAfterMerge"
    | "statusChanged"
    | "merge"
    | "reviewOptions"
    | "cards"
    | "doneAndShipped"
    | "apply"
    | "assertDeletable"
    | "shipPlan"
    | "deleteAfterShip"
  >;
  /** True while an agent of the task works. */
  working: (task: string) => boolean;
  hosts: Record<MrHost, MrHostClient>;
  /** Asks the host helper to load the owner's SSH keys again, after a push or fetch they lacked. */
  reloadKeys?: () => Promise<boolean>;
  /** Pushes https remotes from the computer with its saved login. Without it only SSH routes push. */
  hostGit?: HostGit;
  /**
   * Reads a token reference, refreshing a signed-in GitLab or Bitbucket token that is about to
   * expire. Without it the secret is read as is.
   */
  freshToken?: (ref: string) => Promise<string | undefined>;
  /** The org's own token for an https push, when it signed in to that host. Else the helper uses the saved login. */
  pushAuth?: (org: string, url: string) => Promise<GitAuth | undefined>;
  now?: () => Date;
}

/** Everything one repo needs to talk to its remote and its MR host. */
interface RepoContext {
  repo: TaskRepo;
  project: ProjectInfo;
  remote: string;
  remoteConfig: RemoteConfig | undefined;
  pushUrl: string | undefined;
  /** True when `pushUrl` is https and the computer pushes it. */
  viaHost: boolean;
  target: Omit<MrTarget, "token">;
  client: MrHostClient;
}

/** The host an alias reaches, read from the logins found for it. */
function aliasHost(
  alias: string,
  hosts:
    | readonly {
        host: string;
        logins: readonly { alias?: string | undefined }[];
      }[]
    | undefined,
): string | undefined {
  return hosts?.find((h) => h.logins.some((l) => l.alias === alias))?.host;
}

/** A refusal the owner fixes on another page: Ship links straight to it. */
class FixableError extends UserError {
  constructor(
    message: string,
    readonly fix: ShipFix,
  ) {
    super(message, 409);
  }
}

/** Pushing, opening, watching and merging the MRs of a task's repos (SPEC 5.5). */
export class MrService {
  private readonly busy = new Set<string>();
  /** Ships into one project and base branch go one at a time, in the order asked (5.18). */
  private readonly ships = new ShipQueue();
  /** Problems already said in the room, by task and kind, so a poll that fails the same way stays quiet. */
  private readonly said = new Map<string, string>();

  constructor(private readonly deps: MrDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private note(task: string, text: string, level: "info" | "error" = "info"): void {
    this.deps.room.post(task, `${level}:${randomUUID()}`, {
      type: "system",
      level,
      text,
    });
  }

  private audit(
    task: string,
    kind: "push" | "mr" | "merge" | "merge+push" | "update",
    who: string,
    ok: boolean,
    detail: string,
    project: string,
  ): void {
    logShip(this.deps.store, {
      task,
      kind,
      who,
      ok,
      project,
      detail,
      at: this.now(),
    });
  }

  /** Says a problem once until it changes or clears. */
  private problem(task: string, key: string, text: string): void {
    if (this.firstTime(task, key, text)) this.note(task, text, "error");
  }

  /** True the first time this key holds this text for the task, until it is resolved. */
  private firstTime(task: string, key: string, text: string): boolean {
    if (this.said.get(`${task}|${key}`) === text) return false;
    this.said.set(`${task}|${key}`, text);
    return true;
  }

  /** The problem of this kind is gone: a later one is news again. */
  private resolved(task: string, keyPrefix: string): void {
    for (const key of this.said.keys()) if (key.startsWith(`${task}|${keyPrefix}`)) this.said.delete(key);
  }

  private publish(id: string): Task {
    const task = this.deps.tasks.get(id);
    this.deps.room.publishTask(task);
    this.deps.events.emit(["tasks"]);
    return task;
  }

  // ---------------------------------------------------------------------------
  // Merge order

  private async graph(): Promise<ProjectGraph> {
    const infos = await this.deps.projects.infos();
    return new Map(infos.map((p) => [p.id, p.links.map((l: ProjectLink) => l.to)] as const));
  }

  /** Repos in merge order: the owner's override when every repo has a place, else the project links. */
  private async ordered(task: Task): Promise<{ repos: TaskRepo[]; overridden: boolean }> {
    const places = task.repos.map((r) => r.mergeOrder);
    if (places.length > 0 && places.every((p) => p !== undefined)) {
      const repos = [...task.repos].sort((a, b) => (a.mergeOrder ?? 0) - (b.mergeOrder ?? 0));
      return { repos, overridden: true };
    }
    try {
      const order = mergeOrder(
        task.repos.map((r) => r.project),
        await this.graph(),
      );
      return {
        repos: order.flatMap((p) => task.repos.filter((r) => r.project === p)),
        overridden: false,
      };
    } catch (err) {
      if (err instanceof MergeOrderCycle) throw new UserError(err.message, 409);
      throw err;
    }
  }

  async order(id: string): Promise<MergeOrder> {
    const { repos, overridden } = await this.ordered(this.deps.tasks.get(id));
    return { order: repos.map((r) => r.project), overridden };
  }

  async setOrder(id: string, order: readonly string[] | null): Promise<Task> {
    const task = this.deps.tasks.get(id);
    if (order !== null) {
      const have = task.repos.map((r) => r.project).sort();
      const given = [...order].sort();
      if (have.length !== given.length || have.some((p, i) => p !== given[i])) {
        throw new UserError(`List every repo of ${id} once: ${task.repos.map((r) => r.project).join(", ")}.`);
      }
      const problems = orderViolations(order, await this.graph());
      for (const p of problems) this.note(id, `Merge order: ${p}.`);
    }
    if (task.repos.some((r) => r.mr?.state === "merged")) {
      throw new UserError("A merge request is already merged, so the order can no longer change.", 409);
    }
    this.deps.store.tasks.setMergeOrder(id, order);
    return this.publish(id);
  }

  // ---------------------------------------------------------------------------
  // Credentials and targets

  private async token(
    project: ProjectInfo,
    host: MrHost,
    remote: RemoteConfig | undefined,
  ): Promise<string | undefined> {
    const orgs = (await this.deps.config.sections()).orgs;
    const ref = remote?.token ?? orgs[project.org]?.mr_tokens?.[host];
    if (ref === undefined) return undefined;
    const name = ref.replace(/^secret:/, "");
    const value =
      this.deps.freshToken === undefined
        ? await this.deps.secrets.get(name).catch(() => undefined)
        : await this.deps.freshToken(ref).catch(() => this.deps.secrets.get(name).catch(() => undefined));
    if (value === undefined) {
      throw new UserError(
        `${project.id} uses ${ref} for ${host}, but there is no such secret. Save it, or change the reference.`,
      );
    }
    return value;
  }

  private async policy(task: Task): Promise<MergePolicy> {
    const orgs = (await this.deps.config.sections()).orgs;
    return orgs[task.org ?? "private"]?.merge ?? DEFAULT_MERGE_POLICY;
  }

  private async context(repo: TaskRepo): Promise<RepoContext> {
    const project = await this.deps.projects.get(repo.project).catch(() => undefined);
    if (project === undefined) throw new UserError(`Project ${repo.project} is not registered any more.`);
    const remote = mrRemoteName(project.remotes);
    const remoteConfig = project.remotes[remote];
    const url = await remoteUrl(repo.source, remote).catch((err: unknown) => {
      throw new UserError(errorMessage(err));
    });
    const host = mrHostOf(remoteConfig, url);
    if (host === undefined) {
      throw new UserError(
        `Cannot tell which git host ${project.id} is on (${remote} is ${url}). Set host to github, gitlab or bitbucket on the remote in the project.`,
      );
    }
    const hostName = remoteConfig?.ssh === undefined ? hostNameOf(url) : undefined;
    let pushUrl = rewriteRemoteUrl(url, remoteConfig?.ssh);
    let viaHost = false;
    if (/^https?:\/\//i.test(pushUrl)) {
      const routed = await this.routeFor(url, undefined, project.org);
      pushUrl = routed.url ?? pushUrl;
      viaHost = routed.route.state === "https";
    }
    return {
      repo,
      project,
      remote,
      remoteConfig,
      pushUrl: pushUrl === url ? undefined : pushUrl,
      viaHost,
      target: {
        host,
        slug: repoSlug(url),
        ...(hostName === undefined ? {} : { hostName }),
      },
      client: this.deps.hosts[host],
    };
  }

  private async targetOf(ctx: RepoContext): Promise<MrTarget> {
    const token = await this.token(ctx.project, ctx.target.host, ctx.remoteConfig);
    return { ...ctx.target, ...(token === undefined ? {} : { token }) };
  }

  // ---------------------------------------------------------------------------
  // Push and open

  /** Pushes each repo, opens one MR per repo in merge order, then writes the sibling links into each. */
  async open(id: string, pick: ShipTargets = {}, by?: string): Promise<OpenMrsResult> {
    const task = this.deps.tasks.get(id);
    if (task.status !== "review" && task.status !== "mr") {
      throw new UserError(`${id} is ${task.status}. Open merge requests from review.`, 409);
    }
    if (this.deps.working(id)) {
      throw new UserError(
        `An agent of ${id} is working. Wait for its turn to end, then open the merge requests.`,
        409,
      );
    }
    return this.exclusive(id, async () => {
      const { repos } = await this.ordered(task);
      const plans = await this.preflight(repos, pick, task.repos);
      const results: OpenMrsResult["repos"] = [];
      const opened: { ctx: RepoContext; target: MrTarget; number: number }[] = [];
      let failed = false;

      for (const plan of plans) {
        const { ctx } = plan;
        const project = ctx.project.id;
        if (plan.skip !== undefined) {
          results.push({ project, outcome: "skipped", detail: plan.skip });
          continue;
        }
        if (failed) {
          results.push({
            project,
            outcome: "skipped",
            detail: "Not tried: an earlier repo failed.",
          });
          continue;
        }
        try {
          const target = await this.targetOf(ctx);
          const worktree = ctx.repo.worktree as string;
          const push = {
            worktree,
            remote: ctx.remote,
            branch: ctx.repo.branch,
            url: ctx.pushUrl,
            viaHost: this.hostPusher(ctx.viaHost, worktree, ctx.project.org),
            reloadKeys: this.deps.reloadKeys,
          };
          // A branch the remote already has at this tip is not pushed again.
          const current = await remoteHasTip(push);
          if (!current) await pushBranch(push);
          this.deps.store.tasks.setPushed(id, project, this.now().toISOString());
          const existing = this.deps.store.tasks.get(id)?.repos.find((r) => r.project === project)?.mr;
          if (existing !== undefined && existing.state === "open") {
            opened.push({ ctx, target, number: existing.number });
            results.push({
              project,
              outcome: "updated",
              url: existing.url,
              detail: current
                ? `${ctx.repo.branch} is already up to date on ${ctx.remote}, and the merge request is open.`
                : `Pushed ${ctx.repo.branch}; the merge request is already open.`,
            });
            continue;
          }
          const body = this.body(task, project, this.siblings(id, plans));
          const mr = await ctx.client.open(target, {
            head: ctx.repo.branch,
            base: plan.into ?? ctx.repo.base,
            title: await this.titleOf(task, ctx.repo),
            body,
          });
          this.deps.store.tasks.setMr(id, project, {
            url: mr.url,
            number: mr.number,
            state: "open",
            ci: "none",
          });
          opened.push({ ctx, target, number: mr.number });
          results.push({
            project,
            outcome: "opened",
            url: mr.url,
            detail: `Pushed ${ctx.repo.branch} and opened ${mr.url}.`,
          });
        } catch (err) {
          failed = true;
          results.push({
            project,
            outcome: "failed",
            detail: errorMessage(err),
          });
        }
      }

      // Every MR is open now, so each description can name all of them.
      for (const { ctx, target, number } of opened) {
        try {
          const project = ctx.project.id;
          await ctx.client.updateDescription(target, number, {
            title: await this.titleOf(task, ctx.repo),
            body: this.body(task, project, this.siblings(id, plans)),
          });
        } catch (err) {
          this.note(
            id,
            `${ctx.project.id}: could not add the sibling links to the description (${errorMessage(err)}).`,
            "error",
          );
        }
      }

      for (const r of results)
        this.note(id, `${r.project}: ${r.detail}`, r.outcome === "failed" ? "error" : "info");
      for (const r of results) {
        if (r.outcome === "skipped") continue;
        this.audit(id, "mr", by ?? "owner", r.outcome !== "failed", r.url ?? r.detail, r.project);
      }
      const anyMr = this.deps.store.tasks.get(id)?.repos.some((r) => r.mr !== undefined) === true;
      if (!failed && anyMr) {
        if (task.status !== "mr") {
          const target = [
            ...new Set(plans.filter((p) => p.skip === undefined).map((p) => p.into ?? p.ctx.repo.base)),
          ].join(", ");
          // Settles the review card with what was opened.
          await this.deps.tasks.apply(
            id,
            { type: "mrOpened" },
            { ctx: { by: by ?? "owner", settle: `Opened merge requests into ${target}` } },
          );
          this.note(id, "Merge requests are open. Waiting for them to be merged.");
        }
        this.publish(id);
        await this.deps.tasks.statusChanged(id);
      } else if (failed) {
        this.note(
          id,
          "Stopped at the first failure. Nothing was undone: fix the cause and open the merge requests again to continue.",
          "error",
        );
        this.publish(id);
      }
      return { task: this.deps.tasks.get(id), repos: results };
    });
  }

  /** The sibling list for one description: repos with an MR, in merge order, from the store. */
  private siblings(id: string, plans: readonly Plan[]): { project: string; url?: string | undefined }[] {
    const stored = this.deps.store.tasks.get(id)?.repos ?? [];
    return plans
      .filter(
        (p) => p.skip === undefined || stored.find((r) => r.project === p.ctx.project.id)?.mr !== undefined,
      )
      .map((p) => ({
        project: p.ctx.project.id,
        url: stored.find((r) => r.project === p.ctx.project.id)?.mr?.url,
      }));
  }

  /** `feat(acm-1): add login` when the repo's commits follow Conventional Commits, else `ACM-1: Add login`. */
  private async titleOf(task: Task, repo: TaskRepo): Promise<string> {
    const { commits } = await readRepoStyle(repo.source);
    const type = typeOfBranch(repo.branch) ?? inferBranchType(task.title);
    return titleFor({ id: task.id, title: task.title, type }, commits);
  }

  private body(
    task: Task,
    project: string,
    siblings: { project: string; url?: string | undefined }[],
  ): string {
    return renderMrDescription({
      taskId: task.id,
      title: task.title,
      brief: task.brief,
      project,
      siblings,
    });
  }

  /** Checks every repo before anything is pushed, so a problem in the last one does not leave the first half sent. */
  private async preflight(
    repos: readonly TaskRepo[],
    pick: ShipTargets,
    all: readonly TaskRepo[],
  ): Promise<Plan[]> {
    const plans: Plan[] = [];
    // A repo the task did not change gets no merge request, and needs no worktree or token.
    const { changed } = await splitChanged(repos);
    const targets = targetsFor(changed, pick, all);
    for (const repo of repos) {
      const ctx = await this.context(repo);
      const project = ctx.project.id;
      if (!changed.includes(repo) && repo.mr === undefined) {
        plans.push({ ctx, skip: NO_CHANGES });
        continue;
      }
      // majhi never pushes a protected repo for a merge request: it ships only alone, by the owner.
      if (ctx.project.protected) {
        plans.push({ ctx, skip: HELD });
        continue;
      }
      if (repo.worktree === undefined) {
        throw new UserError(`${project} has no worktree, so there is nothing to push.`);
      }
      const dirty = (await uncommitted(repo.worktree).catch(() => [])).filter((l) => !l.startsWith("??"));
      if (dirty.length > 0) {
        throw new UserError(
          `${project} has uncommitted changes. Ask the agent to commit them, then open the merge requests.`,
          409,
          dirty.slice(0, 5),
        );
      }
      if (repo.mr?.state === "merged") {
        plans.push({ ctx, skip: "Its merge request is already merged." });
        continue;
      }
      // Every host needs a token from an org or remote setting: majhi never falls back to a login
      // that happens to be on the machine, which could belong to another org.
      const token = await this.token(ctx.project, ctx.target.host, ctx.remoteConfig);
      if (token === undefined) {
        throw new UserError(
          `No ${ctx.target.host} token is set for ${project}. Save one (secrets.save) and set it as mr_tokens.${ctx.target.host} on the org ${ctx.project.org}, or as token on the remote ${ctx.remote} of the project.`,
        );
      }
      const base = targets.get(repo.project) ?? repo.base;
      const ahead = await commitsAhead(repo.source, base, ctx.remote, repo.branch).catch(() => 0);
      const hasMr = repo.mr !== undefined;
      plans.push(
        ahead === 0 && !hasMr
          ? {
              ctx,
              skip: `${repo.branch} has no commits past ${base}, so there is nothing to merge.`,
            }
          : { ctx, into: base },
      );
    }
    if (plans.every((p) => p.skip !== undefined)) {
      throw new UserError("No repo of this task has a commit to send.", 409);
    }
    return plans;
  }

  // ---------------------------------------------------------------------------
  // Ship: push, merge and push, and what each can do now

  /** Every Ship action for a task, allowed or refused with the reason and where to fix it. */
  async shipOptions(id: string): Promise<ShipOptions> {
    const task = this.deps.tasks.get(id);
    const local = await this.deps.tasks.reviewOptions(id);
    // Ship sends only the repos with changes; the rest are listed as skipped. Protected ones are
    // listed apart: each ships only alone.
    const split = await splitChanged(task.repos);
    const guarded = new Set((await this.deps.projects.infos()).filter((p) => p.protected).map((p) => p.id));
    const changed = split.changed.filter((r) => !guarded.has(r.project));
    const held = split.changed.filter((r) => guarded.has(r.project));
    const { unchanged } = split;
    const base = changed[0]?.base ?? local.base;
    const push = await this.option(async () => {
      const ready = await this.pushReady(task, changed);
      let ahead = 0;
      for (const { repo, target } of ready) {
        ahead += await commitsAhead(repo.source, repo.base, target.remote, repo.branch).catch(() => 1);
      }
      if (ahead === 0) throw new UserError(`Nothing to push: no commits ahead of ${base ?? "the base"}.`);
    });
    let host: MrHost | undefined;
    const mr = !push.ok
      ? push
      : task.status !== "review" && task.status !== "mr"
        ? {
            ok: false,
            why: `Open merge requests from review. ${id} is ${task.status}.`,
          }
        : await this.option(async () => {
            for (const repo of changed) {
              const ctx = await this.context(repo);
              host ??= ctx.target.host;
              if ((await this.token(ctx.project, ctx.target.host, ctx.remoteConfig)) === undefined) {
                const org =
                  (await this.deps.config.sections()).orgs[ctx.project.org]?.name ?? ctx.project.org;
                throw new FixableError(`No ${HOST_LABEL[ctx.target.host]} token: add one in Orgs > ${org}.`, {
                  page: "orgs",
                  org: ctx.project.org,
                });
              }
            }
          });
    if (host === undefined) {
      const first = changed[0] ?? task.repos[0];
      host =
        first === undefined
          ? undefined
          : await this.context(first).then(
              (c) => c.target.host,
              () => undefined,
            );
    }
    return {
      ...(base === undefined ? {} : { base }),
      ...(host === undefined ? {} : { host }),
      changed: changed.map((r) => ({
        project: r.project,
        base: r.base,
        branch: r.branch,
      })),
      unchanged: unchanged.map((r) => r.project),
      protected: held.map((r) => ({
        project: r.project,
        base: r.base,
        branch: r.branch,
      })),
      merge: local.merge,
      mergePush: local.merge.ok ? push : local.merge,
      push,
      mr,
      done: local.done,
    };
  }

  private async option(check: () => Promise<void>): Promise<ShipOption> {
    try {
      await check();
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        why: errorMessage(err),
        ...(err instanceof FixableError ? { fix: err.fix } : {}),
      };
    }
  }

  /**
   * Pushes each repo's task branch to its MR remote, with no merge request. Never forced. With
   * `deleteAfter`, a push that worked everywhere removes the worktrees and local branches; the
   * remote branches stay.
   */
  async push(id: string, deleteAfter = false, by = "owner"): Promise<{ results: ShipResult[]; task: Task }> {
    const task = this.deps.tasks.get(id);
    return this.exclusive(id, async () => {
      const plan = await this.deps.tasks.shipPlan(task, {});
      const ready = await this.pushReady(
        task,
        plan.ship.map((s) => s.repo),
      );
      if (deleteAfter) await this.deps.tasks.assertDeletable(ready.map((r) => r.repo));
      const results: ShipResult[] = [];
      const heads = new Map<string, string>();
      for (const { repo, target } of ready) {
        const project = repo.project;
        try {
          heads.set(project, (await git(repo.source, ["rev-parse", `refs/heads/${repo.branch}`])).trim());
          await pushBranch({
            worktree: repo.worktree as string,
            remote: target.remote,
            branch: repo.branch,
            url: target.pushUrl,
            viaHost: this.hostPusher(target.viaHost, repo.worktree as string, target.org),
            reloadKeys: this.deps.reloadKeys,
          });
          this.deps.store.tasks.setPushed(id, project, this.now().toISOString());
          results.push({
            project,
            into: repo.branch,
            ok: true,
            detail: `Pushed ${repo.branch} to ${target.remote}.`,
          });
        } catch (err) {
          results.push({
            project,
            into: repo.branch,
            ok: false,
            detail: pushFailure(err, target.remote, repo.branch),
          });
        }
      }
      for (const r of results) this.note(id, `${r.project}: ${r.detail}`, r.ok ? "info" : "error");
      for (const { repo, target } of ready) {
        const r = results.find((x) => x.project === repo.project);
        if (r === undefined) continue;
        this.audit(id, "push", by, r.ok, r.ok ? `${target.remote}/${repo.branch}` : r.detail, r.project);
      }
      const skipped = [...plan.unchanged.map(skippedResult), ...plan.held.map(heldResult)];
      if (deleteAfter && results.every((r) => r.ok)) {
        return {
          results: [...(await this.withDeleted(id, results, heads)), ...skipped],
          task: this.publish(id),
        };
      }
      return { results: [...results, ...skipped], task: this.publish(id) };
    });
  }

  /** Deletes the worktrees and local branches after a clean ship, and adds what happened to each result. */
  private async withDeleted(
    id: string,
    results: readonly ShipResult[],
    heads: ReadonlyMap<string, string>,
  ): Promise<ShipResult[]> {
    const deleted = await this.deps.tasks.deleteAfterShip(id, heads);
    return results.map((r) => {
      const extra = deleted.get(r.project);
      return extra === undefined ? r : { ...r, detail: `${r.detail} ${extra}` };
    });
  }

  /**
   * Merges the task into a local branch in each changed repo, then pushes those branches to the MR
   * remote. All or nothing up to the push: every repo must merge cleanly, and every remote target
   * must already be in its local copy (never forced), before anything merges. A push that fails
   * after the merges leaves that repo merged and not pushed, said per repo, so Push again sends it.
   */
  async mergeAndPush(input: {
    id: string;
    into?: string | undefined;
    /** The owner confirmed pushing local commits on a target that are not the task's. */
    pushLocalCommits?: boolean | undefined;
    /** The owner confirmed creating a target branch the remote does not have. */
    createRemoteBranch?: boolean | undefined;
    /** The owner typed this protected repo's name to ship it alone. */
    confirmProtected?: string | undefined;
    targets?: Readonly<Record<string, string>> | undefined;
    project?: string | undefined;
    done: boolean;
    by: string;
    method?: MergeMethod | undefined;
    deleteAfter?: boolean | undefined;
  }): Promise<{ results: ShipResult[]; task: Task }> {
    const task = this.deps.tasks.get(input.id);
    const into = (project: string, base: string): string => input.targets?.[project] ?? input.into ?? base;
    const keys = task.repos
      .filter((r) => input.project === undefined || r.project === input.project)
      .map((r) => ShipQueue.key(r.project, into(r.project, r.base)));
    return this.exclusive(input.id, keys, async () => {
      const plan = await this.deps.tasks.shipPlan(task, input);
      const ready = await this.pushReady(
        task,
        plan.ship.map((s) => s.repo),
      );
      if (input.deleteAfter === true) await this.deps.tasks.assertDeletable(ready.map((r) => r.repo));
      const targets = planTargets(plan);
      // Every remote target is read before anything merges. A push sends the whole local target,
      // so commits on it that are not the task's, or a branch the remote does not have, go out
      // only when the owner confirmed it.
      const behind: { project: string; remote: string; into: string }[] = [];
      const asks: string[] = [];
      for (const { repo, target } of ready) {
        const into = targets[repo.project] ?? repo.base;
        const state = await this.remoteState(repo.source, target, into, {
          branch: repo.branch,
          subject: `Merge ${task.id}: `,
        });
        if (state.behind) behind.push({ project: repo.project, remote: target.remote, into });
        if (state.missing && input.createRemoteBranch !== true) {
          asks.push(
            state.unknown
              ? `majhi cannot read ${target.remote}/${into} for ${repo.project} from here, so it cannot tell what the push would send. ${CONFIRM_NEW}`
              : `${target.remote} has no branch ${into} for ${repo.project}. ${CONFIRM_NEW}`,
          );
        }
        if (state.extra.length > 0 && input.pushLocalCommits !== true) {
          const n = state.extra.length;
          asks.push(
            `Your local ${into} in ${repo.project} has ${n} commit${n === 1 ? "" : "s"} that ${target.remote} does not have and that are not this task's: ${state.extra.slice(0, 5).join("; ")}${n > 5 ? "; and more" : ""}. ${CONFIRM_EXTRA}`,
          );
        }
      }
      if (asks.length > 0 && behind.length === 0) throw new UserError(asks.join(" "), 409);
      if (behind.length > 0) {
        const lines = behind.map(
          (b) => `${b.remote}/${b.into} has commits that your local ${b.into} in ${b.project} does not have.`,
        );
        const which = behind.length === 1 ? (behind[0]?.into ?? "it") : "them";
        throw new UserError(
          `${lines.join(" ")} majhi never force-pushes: bring ${which} up to date first, then ship again.`,
          409,
        );
      }
      const merged = await this.deps.tasks.merge({
        id: input.id,
        targets,
        project: input.project,
        confirmProtected: input.confirmProtected,
        done: false,
        by: input.by,
        settle: false,
        method: input.method,
      });
      if (!merged.results.every((r) => r.ok)) return merged;
      // The commit each branch is at once merged: "delete after" removes it only if it stays there.
      const heads = new Map<string, string>();
      for (const { repo } of ready) {
        heads.set(repo.project, (await git(repo.source, ["rev-parse", `refs/heads/${repo.branch}`])).trim());
      }
      const results: ShipResult[] = [];
      for (const { repo, target } of ready) {
        const into = targets[repo.project] ?? repo.base;
        try {
          await pushBranch({
            worktree: repo.source,
            remote: target.remote,
            branch: into,
            url: target.pushUrl,
            viaHost: this.hostPusher(target.viaHost, repo.source, target.org),
            reloadKeys: this.deps.reloadKeys,
          });
          results.push({
            project: repo.project,
            into,
            ok: true,
            detail: `Pushed ${into} to ${target.remote}.`,
          });
        } catch (err) {
          results.push({
            project: repo.project,
            into,
            ok: false,
            notPushed: true,
            detail: `Merged into ${into}, but ${pushFailure(err, target.remote, into)}`,
          });
        }
      }
      for (const r of results) this.note(input.id, `${r.project}: ${r.detail}`, r.ok ? "info" : "error");
      for (const r of results) {
        const target = ready.find((x) => x.repo.project === r.project)?.target;
        this.audit(
          input.id,
          "merge+push",
          input.by,
          r.ok,
          r.ok ? `${target?.remote ?? "origin"}/${r.into}` : r.detail,
          r.project,
        );
      }
      const stuck = results.filter((r) => r.notPushed === true);
      if (stuck.length > 0) {
        this.note(
          input.id,
          `Merged in your checkout but not pushed: ${stuck.map((r) => `${r.project} (${r.into})`).join(", ")}. Nothing was undone. Fix the cause, then Push again.`,
          "error",
        );
      }
      const skipped = [...plan.unchanged.map(skippedResult), ...plan.held.map(heldResult)];
      if (results.every((r) => r.ok) && plan.held.length === 0) {
        const into = [...new Set(results.map((r) => r.into))].join(", ");
        await this.deps.tasks.closeAfterMerge(input.id, {
          done: input.done === true,
          into,
          settle: true,
          by: input.by,
          pushed: true,
        });
        if (input.deleteAfter === true) {
          return {
            results: [...(await this.withDeleted(input.id, results, heads)), ...skipped],
            task: this.publish(input.id),
          };
        }
      }
      return {
        results: [...results, ...skipped],
        task: this.publish(input.id),
      };
    });
  }

  /** Where a repo's branches are pushed: the MR remote, through the project's SSH alias. */
  private async pushTarget(repo: TaskRepo): Promise<PushTarget> {
    const project = await this.deps.projects.get(repo.project).catch(() => undefined);
    if (project === undefined)
      throw new UserError(
        `${repo.project} is not a registered project any more. Register it in Projects.`,
        409,
      );
    const remote = mrRemoteName(project.remotes);
    const url = await remoteUrl(repo.source, remote).catch(() => undefined);
    if (url === undefined)
      throw new FixableError(
        `${project.id} has no MR remote: there is no remote named ${remote}. Pick its MR remote in Projects.`,
        { page: "projects", project: project.id },
      );
    const pushUrl = rewriteRemoteUrl(url, project.remotes[remote]?.ssh);
    if (/^https?:\/\//i.test(pushUrl)) {
      const routed = await this.routeFor(url, undefined, project.org);
      if (routed.url !== undefined)
        return {
          org: project.org,
          remote,
          pushUrl: routed.url,
          viaHost: routed.route.state === "https",
        };
      const fix = { page: "projects", project: project.id } as const;
      if (routed.route.state === "org-missing") {
        throw new FixableError(
          `${project.org} uses the git account ${routed.route.account}, but no SSH key on this computer logs in as it. Fix it in the org's Git accounts.`,
          { page: "orgs", org: project.org },
        );
      }
      if (routed.route.state === "ambiguous") {
        const host = hostNameOf(url) ?? "the host";
        const choices = routed.route.choices.map((c) => describeLogin(host, c)).join(", ");
        throw new FixableError(
          `${project.id}'s ${remote} remote is https, and more than one key could push it (${choices}). Pick one in Projects.`,
          fix,
        );
      }
      throw new FixableError(
        `No SSH alias for ${project.id}'s ${remote} remote, and majhi pushes over SSH, not https. Pick an alias for it in Projects.`,
        fix,
      );
    }
    return {
      org: project.org,
      remote,
      pushUrl: pushUrl === url ? undefined : pushUrl,
      viaHost: false,
    };
  }

  /** The push function for an https route, or undefined for SSH and plain remotes. */
  private hostPusher(
    viaHost: boolean,
    path: string,
    org: string,
  ): ((url: string, branch: string) => Promise<void>) | undefined {
    const hostGit = this.deps.hostGit;
    if (!viaHost || hostGit === undefined) return undefined;
    const pushAuth = this.deps.pushAuth;
    return async (url, branch) => {
      const auth = pushAuth === undefined ? undefined : await pushAuth(org, url).catch(() => undefined);
      await hostGit.push({ path, url, branch, ...(auth === undefined ? {} : { auth }) });
    };
  }

  /** The SSH route for an https remote, from the keys this computer's logins show. `url` is the push address when one fits. */
  private async routeFor(
    url: string,
    explicit: string | undefined,
    orgId?: string,
  ): Promise<{ route: PushRoute; url: string | undefined }> {
    const host = hostNameOf(url);
    const found =
      host === undefined
        ? undefined
        : await this.deps.gitLogins?.list().then(
            (r) => r.hosts,
            () => undefined,
          );
    const bound =
      host === undefined || orgId === undefined
        ? undefined
        : (await this.deps.config.sections()).orgs[orgId]?.git_accounts?.find((a) => a.host === host);
    const route = chooseRoute({
      host,
      explicit,
      org: bound === undefined ? undefined : { account: bound.account, ssh: bound.ssh },
      owner: ownerOf(url),
      logins: host === undefined || found === undefined ? [] : loginsOf(found, host),
      httpsOk: this.deps.hostGit?.connected() === true && /^https:\/\//i.test(url),
    });
    if (route.state === "auto") return { route, url: httpsToSsh(url, route.alias) };
    if (route.state === "picked") return { route, url: httpsToSsh(url, route.alias) };
    if (route.state === "https") return { route, url: httpsPushUrl(url, route.account) };
    return { route, url: undefined };
  }

  /** How `project` pushes its MR remote, for the project page. */
  async pushRoute(id: string): Promise<{
    host: string | undefined;
    state: Exclude<PushRoute["state"], "org-missing"> | "ssh";
    label?: string;
    choices: Array<{ alias?: string; account: string; label: string }>;
  }> {
    const project = await this.deps.projects.get(id);
    const remote = mrRemoteName(project.remotes);
    const url = await remoteUrl(project.path, remote).catch(() => undefined);
    const host = url === undefined ? undefined : hostNameOf(url);
    if (url === undefined || host === undefined) return { host: undefined, state: "none", choices: [] };
    const explicit = project.remotes[remote]?.ssh;
    const https = /^https?:\/\//i.test(url);
    if (!https && explicit === undefined) return { host, state: "ssh", choices: [] };
    const { route } = await this.routeFor(url, explicit, project.org);
    const logins = (await this.deps.gitLogins?.list().catch(() => undefined))?.hosts;
    const hostKey = explicit === undefined ? host : (aliasHost(explicit, logins) ?? host);
    const choices = (logins === undefined ? [] : loginsOf(logins, hostKey))
      .filter((l) => l.via === "ssh")
      .map((l) => ({
        ...(l.alias === undefined ? {} : { alias: l.alias }),
        account: l.account,
        label: describeLogin(hostKey, l),
      }));
    if (route.state === "auto") {
      return {
        host,
        state: "auto",
        label: `Pushes as ${route.account} via ${route.alias ?? hostKey} key`,
        choices,
      };
    }
    if (route.state === "https") {
      return {
        host,
        state: "https",
        label: `Pushes over https from this computer${route.account === undefined ? "" : ` as ${route.account}`}, with its saved login`,
        choices,
      };
    }
    if (route.state === "picked") {
      const account = choices.find((c) => c.alias === route.alias)?.account;
      return {
        host,
        state: "picked",
        label:
          account === undefined ? `Pushes via ${route.alias}` : `Pushes as ${account} via ${route.alias} key`,
        choices,
      };
    }
    return {
      host,
      state: route.state === "org-missing" ? "none" : route.state,
      choices,
    };
  }

  /**
   * The repos a ship sends (its changed ones), each ready to push: a worktree, all committed, a
   * remote to push to.
   */
  private async pushReady(
    task: Task,
    repos: readonly TaskRepo[],
  ): Promise<{ repo: TaskRepo; target: PushTarget }[]> {
    const shipped = await this.deps.tasks.doneAndShipped(task);
    if (shipped !== undefined) throw new UserError(shipped, 409);
    if (task.repos.length === 0) throw new UserError("The task has no repo.", 409);
    if (this.deps.working(task.id))
      throw new UserError("An agent is working. Wait for its turn to end.", 409);
    if (repos.length === 0)
      throw new UserError("Nothing to ship: no repo has changes since the task started.", 409);
    const out: { repo: TaskRepo; target: PushTarget }[] = [];
    for (const repo of repos) {
      if (repo.worktree === undefined)
        throw new UserError(`${repo.project} has no worktree yet, so there is nothing to push.`, 409);
      const dirty = (await uncommitted(repo.worktree).catch(() => [])).filter((l) => !l.startsWith("??"));
      if (dirty.length > 0)
        throw new UserError(`${repo.project} has uncommitted changes. Ask the agent to commit them.`, 409);
      out.push({ repo, target: await this.pushTarget(repo) });
    }
    return out;
  }

  /**
   * What pushing the local `branch` would do to the remote's: `behind` when the remote has commits
   * the local one lacks (a push would need a force), `extra` the local commits the remote lacks
   * (they would go out with the push), `missing` when the push would create the branch. Reads the
   * remote first. The computer's https route cannot be read from here: the last fetched copy stands in,
   * and with none the result is `missing` and `unknown`. The task's own commits are not extra:
   * those on its branch, and the merge or squash commits majhi made for it (`own.subject`).
   */
  private async remoteState(
    source: string,
    target: PushTarget,
    branch: string,
    own: { branch: string; subject: string },
  ): Promise<{
    behind: boolean;
    extra: string[];
    missing: boolean;
    unknown: boolean;
  }> {
    const none = { behind: false, extra: [], missing: false, unknown: false };
    if (!(await localBranchExists(source, branch))) return none;
    const tracking = `refs/remotes/${target.remote}/${branch}`;
    if (target.viaHost) {
      if (!(await gitOk(source, ["show-ref", "--verify", "--quiet", tracking]))) {
        return { ...none, missing: true, unknown: true };
      }
    } else if (!(await this.fetchTracking(source, target, branch))) {
      return { ...none, missing: true };
    }
    const behind = !(await gitOk(source, ["merge-base", "--is-ancestor", tracking, `refs/heads/${branch}`]));
    const extra = (
      await git(source, [
        "log",
        "--format=%h %s",
        `${tracking}..refs/heads/${branch}`,
        "--not",
        `refs/heads/${own.branch}`,
      ])
    )
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.slice(l.indexOf(" ") + 1).startsWith(own.subject));
    return { behind, extra, missing: false, unknown: false };
  }

  /**
   * Fetches the remote's `branch` into its tracking ref. False when the remote has no such branch.
   * Forced (`+`) on purpose: the tracking ref must be what the remote has now, also after a rewrite
   * there. A plain fetch would refuse and leave a stale ref that still names commits the remote
   * dropped, which is the unsafe direction for "is this pushed" and for the check that follows.
   * Local branches never move here, and the old value stays in the ref's reflog.
   */
  private async fetchTracking(source: string, target: PushTarget, branch: string): Promise<boolean> {
    const tracking = `refs/remotes/${target.remote}/${branch}`;
    const from = target.pushUrl ?? target.remote;
    const fetch = async (): Promise<string | undefined> => {
      try {
        await git(source, ["fetch", "--quiet", from, `+refs/heads/${branch}:${tracking}`], {
          timeoutMs: FETCH_TIMEOUT_MS,
        });
        return undefined;
      } catch (err) {
        return errorMessage(err);
      }
    };
    let failed = await fetch();
    if (failed !== undefined && isSshAuthFailure(failed) && this.deps.reloadKeys !== undefined) {
      if (await this.deps.reloadKeys().catch(() => false)) failed = await fetch();
    }
    if (failed === undefined) return true;
    if (/couldn't find remote ref|could not find remote ref/i.test(failed)) return false;
    throw new UserError(`Could not read ${target.remote}/${branch} before pushing: ${failed}`, 409);
  }

  /**
   * Brings the owner's local target branch up to the remote's, when that is a pure fast-forward, so a
   * ship that was refused for a behind branch can run. Only the owner asks for it (the command checks).
   */
  async updateTarget(input: {
    id: string;
    into?: string | undefined;
    targets?: Readonly<Record<string, string>> | undefined;
    project?: string | undefined;
    by: string;
  }): Promise<{ results: ShipResult[] }> {
    const task = this.deps.tasks.get(input.id);
    return this.exclusive(input.id, async () => {
      // Only the targets a ship would send to: the changed repos'.
      const plan = await this.deps.tasks.shipPlan(task, input);
      const results: ShipResult[] = [];
      for (const { repo, into } of plan.ship) {
        const target = await this.pushTarget(repo);
        let outcome: FastForwardOutcome;
        if (target.viaHost) {
          outcome = {
            ok: false,
            reason: `${repo.project} pushes with this computer's saved login, which majhi cannot read from here. Update ${into} from ${target.remote} yourself in the project.`,
          };
        } else if (!(await this.fetchTracking(repo.source, target, into))) {
          outcome = {
            ok: false,
            reason: `${target.remote} has no branch ${into}.`,
          };
        } else {
          outcome = await fastForwardBranch({
            source: repo.source,
            branch: into,
            to: `refs/remotes/${target.remote}/${into}`,
            remote: target.remote,
          });
        }
        const detail = outcome.ok ? outcome.detail : outcome.reason;
        results.push({ project: repo.project, into, ok: outcome.ok, detail });
        this.audit(
          input.id,
          "update",
          input.by,
          outcome.ok,
          `${target.remote}/${into}: ${detail}`,
          repo.project,
        );
      }
      return { results };
    });
  }

  // ---------------------------------------------------------------------------
  // State

  /** Reads each open MR from its host. When all are merged, finishes the task. */
  async refresh(id: string): Promise<RefreshMrsResult> {
    const task = this.deps.tasks.get(id);
    return this.exclusive(id, async () => {
      const waited = this.deps.store.tasks.unmergedMrs().has(id);
      await this.readStates(task);
      await this.finishIfMerged(id);
      if (waited) await this.mergedLate(id);
      return { task: this.deps.tasks.get(id), policy: await this.policy(task) };
    });
  }

  /** Stores what each host says about the task's open MRs. Problems are said once in the room. */
  private async readStates(task: Task): Promise<void> {
    for (const repo of task.repos) {
      if (repo.mr === undefined || repo.mr.state !== "open") continue;
      try {
        const ctx = await this.context(repo);
        const status = await ctx.client.status(await this.targetOf(ctx), repo.mr.number);
        const next: RepoMr = {
          url: status.url || repo.mr.url,
          number: repo.mr.number,
          state: status.state,
          ci: status.ci,
          ...(status.review === undefined ? {} : { review: status.review }),
        };
        if (
          next.state !== repo.mr.state ||
          next.ci !== repo.mr.ci ||
          next.url !== repo.mr.url ||
          JSON.stringify(next.review) !== JSON.stringify(repo.mr.review)
        ) {
          this.deps.store.tasks.setMr(task.id, repo.project, next);
          if (next.state === "merged") this.note(task.id, `${repo.project}: the merge request was merged.`);
          if (next.state === "closed")
            this.note(task.id, `${repo.project}: the merge request was closed without merging.`, "error");
          this.publish(task.id);
        }
        this.resolved(task.id, `read:${repo.project}`);
      } catch (err) {
        this.problem(
          task.id,
          `read:${repo.project}`,
          `${repo.project}: could not read the merge request (${errorMessage(err)}).`,
        );
      }
    }
  }

  private async finishIfMerged(id: string): Promise<boolean> {
    const task = this.deps.tasks.get(id);
    const withMr = task.repos.filter((r) => r.mr !== undefined);
    if (task.status !== "mr" || withMr.length === 0 || !withMr.every((r) => r.mr?.state === "merged"))
      return false;
    await this.complete(task);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Merge

  /** Merges in order under the org's policy. `owner`: a click; `poll`: the timer. */
  async merge(id: string, trigger: "owner" | "poll"): Promise<MergeMrsResult> {
    const first = this.deps.tasks.get(id);
    if (first.status !== "mr")
      throw new UserError(`${id} is ${first.status}. Its merge requests are not open.`, 409);
    const policy = await this.policy(first);
    if (policy === "never" && trigger === "owner") {
      throw new UserError(
        "This org's merge policy is never, so majhi does not merge. Merge on the host, then choose I merged it.",
        409,
      );
    }
    if (trigger === "owner") this.resolved(id, "");
    const keys = first.repos.filter((r) => r.mr !== undefined).map((r) => ShipQueue.key(r.project, r.base));
    return this.exclusive(id, keys, async () => {
      const merged: string[] = [];
      let stoppedAt: MergeMrsResult["stoppedAt"];
      for (let guard = 0; guard < 50; guard += 1) {
        const task = this.deps.tasks.get(id);
        await this.readStates(task);
        const fresh = this.deps.tasks.get(id);
        const { repos } = await this.ordered(fresh);
        const order: RepoMrState[] = repos
          .filter((r) => r.mr !== undefined)
          .map((r) => ({
            project: r.project,
            mr: r.mr ? { state: r.mr.state, ci: r.mr.ci } : undefined,
            pushedAt: r.pushedAt,
          }));
        const decision = nextMerge({
          policy,
          trigger,
          order,
          nowMs: this.now().getTime(),
        });
        if (decision.action !== "stop") this.resolved(id, "stop:");
        if (decision.action === "done") break;
        if (decision.action === "wait") break;
        if (decision.action === "stop") {
          stoppedAt = { project: decision.project, reason: decision.reason };
          this.problem(
            id,
            `stop:${decision.project}`,
            `Merging stopped at ${decision.project}: ${decision.reason}`,
          );
          break;
        }
        const repo = fresh.repos.find((r) => r.project === decision.project);
        if (repo?.mr === undefined) break;
        const ctx0 = await this.context(repo).catch(() => undefined);
        if (ctx0?.project.protected === true) {
          // No merge policy merges a protected repo: the owner merges it on the host.
          stoppedAt = {
            project: repo.project,
            reason: `${repo.project} is protected, so majhi never merges it. Merge it on the host yourself, then choose I merged it.`,
          };
          this.problem(id, `stop:${repo.project}`, `Merging stopped at ${repo.project}: ${stoppedAt.reason}`);
          break;
        }
        try {
          const ctx = ctx0 ?? (await this.context(repo));
          const target = await this.targetOf(ctx);
          await ctx.client.merge(target, repo.mr.number);
          const status = await ctx.client.status(target, repo.mr.number);
          this.deps.store.tasks.setMr(id, repo.project, {
            url: status.url || repo.mr.url,
            number: repo.mr.number,
            state: status.state,
            ci: status.ci,
            ...(status.review === undefined ? {} : { review: status.review }),
          });
          // The merge on the host is a merge: the owner's click or the poller's, whichever asked.
          // A poll that finds the host still merging logs it once, not on every pass.
          const who = trigger === "owner" ? "owner" : "majhi";
          const url = status.url || repo.mr.url;
          if (status.state === "merged") this.audit(id, "merge", who, true, url, repo.project);
          else if (this.firstTime(id, `merging:${repo.project}`, url))
            this.audit(id, "merge", who, true, `${url} (host still merging)`, repo.project);
          if (status.state !== "merged") {
            stoppedAt = {
              project: repo.project,
              reason: `${repo.project}: the host took the merge but has not merged it yet. majhi checks again on its own.`,
            };
            this.note(id, stoppedAt.reason);
            break;
          }
          merged.push(repo.project);
          this.note(id, `${repo.project}: merged ${repo.mr.url}.`);
          this.resolved(id, "merge:");
        } catch (err) {
          stoppedAt = { project: repo.project, reason: errorMessage(err) };
          // The poller retries on every pass: the same failure is logged once, as the room says it once.
          const text = `Merging stopped at ${repo.project}: ${errorMessage(err)}`;
          if (this.said.get(`${id}|merge:${repo.project}`) !== text)
            this.audit(
              id,
              "merge",
              trigger === "owner" ? "owner" : "majhi",
              false,
              errorMessage(err),
              repo.project,
            );
          this.problem(
            id,
            `merge:${repo.project}`,
            `Merging stopped at ${repo.project}: ${errorMessage(err)}`,
          );
          break;
        }
      }
      this.publish(id);
      const done = await this.finishIfMerged(id);
      return {
        task: this.deps.tasks.get(id),
        merged,
        ...(stoppedAt === undefined ? {} : { stoppedAt }),
        done,
      };
    });
  }

  /** The owner merged on the host. Checks with the host unless forced. */
  async markMerged(input: {
    id: string;
    project?: string | undefined;
    force: boolean;
  }): Promise<MarkMergedResult> {
    const task = this.deps.tasks.get(input.id);
    if (task.status !== "mr")
      throw new UserError(`${input.id} is ${task.status}. Its merge requests are not open.`, 409);
    const chosen = task.repos.filter(
      (r) => r.mr !== undefined && (input.project === undefined || r.project === input.project),
    );
    if (chosen.length === 0)
      throw new UserError(
        `${input.id} has no open merge request${input.project === undefined ? "" : ` for ${input.project}`}.`,
      );
    return this.exclusive(input.id, async () => {
      await this.readStates(task);
      const stillOpen: MarkMergedResult["stillOpen"] = [];
      for (const repo of this.deps.tasks.get(input.id).repos) {
        if (
          !chosen.some((c) => c.project === repo.project) ||
          repo.mr === undefined ||
          repo.mr.state === "merged"
        )
          continue;
        if (input.force) {
          this.deps.store.tasks.setMr(input.id, repo.project, {
            ...repo.mr,
            state: "merged",
          });
          this.note(input.id, `${repo.project}: recorded as merged, as the owner said.`);
          this.audit(
            input.id,
            "merge",
            "owner",
            true,
            "recorded as merged by the owner, not checked with the host",
            repo.project,
          );
        } else {
          stillOpen.push({ project: repo.project, state: repo.mr.state });
        }
      }
      if (stillOpen.length > 0) {
        this.note(
          input.id,
          `The host still shows ${stillOpen.map((s) => `${s.project} as ${s.state}`).join(", ")}. Merge it there, or record it as merged anyway.`,
          "error",
        );
      }
      this.publish(input.id);
      const done = await this.finishIfMerged(input.id);
      return { task: this.deps.tasks.get(input.id), stillOpen, done };
    });
  }

  // ---------------------------------------------------------------------------
  // After the merge

  /**
   * Every MR is merged: fetch the base so tasks waiting on this one start from it, remove the
   * worktrees (a worktree with uncommitted changes stays), mark the task done and start the tasks
   * that waited. The tracker update and the Housekeeper are not built yet.
   */
  private async complete(task: Task): Promise<void> {
    for (const repo of task.repos) {
      if (repo.mr === undefined) continue;
      const remote = await this.context(repo).then(
        (c) => c.remote,
        () => "origin",
      );
      const failed = await this.fetchBase(repo.source, remote, repo.base);
      if (failed !== undefined) {
        this.note(
          task.id,
          `${repo.project}: could not fetch ${repo.base} from ${remote} (${failed}). Tasks waiting on this one use the last copy on this machine.`,
          "error",
        );
      }
    }
    for (const repo of task.repos) {
      if (repo.worktree === undefined) continue;
      const dirty = await uncommitted(repo.worktree).catch(() => []);
      if (dirty.length > 0) {
        this.note(
          task.id,
          `${repo.project}: kept the worktree ${repo.worktree}, which has uncommitted changes.`,
          "error",
        );
        continue;
      }
      try {
        await removeWorktree(repo.source, repo.worktree, false);
        this.deps.store.tasks.clearWorktree(task.id, repo.project);
      } catch (err) {
        this.note(task.id, `${repo.project}: could not remove the worktree (${errorMessage(err)}).`, "error");
      }
    }
    this.note(task.id, "Every merge request is merged. The task is done.");
    await this.deps.tasks.close(task.id, {
      whenSubtasksOpen: "stay",
      whenUnshipped: "stay",
      by: "majhi",
    });
  }

  private async fetchBase(source: string, remote: string, base: string): Promise<string | undefined> {
    const attempt = async (): Promise<string | undefined> => {
      try {
        await git(source, ["fetch", "--quiet", remote, base], {
          timeoutMs: FETCH_TIMEOUT_MS,
        });
        return undefined;
      } catch (err) {
        return errorMessage(err);
      }
    };
    const failed = await attempt();
    if (failed === undefined || !isSshAuthFailure(failed) || this.deps.reloadKeys === undefined)
      return failed;
    return (await this.deps.reloadKeys().catch(() => false)) ? attempt() : failed;
  }

  // ---------------------------------------------------------------------------
  // Polling

  /** One pass over the tasks in `mr`: read their MRs, merge under `auto-if-green`, notice merges. */
  async poll(): Promise<void> {
    for (const id of this.deps.store.tasks.idsWithStatus("mr")) {
      if (this.busy.has(id)) continue;
      try {
        await this.refresh(id);
        const task = this.deps.tasks.get(id);
        if (task.status === "mr" && (await this.policy(task)) === "auto-if-green")
          await this.merge(id, "poll");
      } catch (err) {
        this.problem(id, "poll", `Could not check the merge requests (${errorMessage(err)}).`);
      }
    }
    // A task closed before its MRs were merged: tasks that wait on it are waiting for the merge.
    for (const id of this.deps.store.tasks.doneWithOpenMrs()) {
      if (this.busy.has(id)) continue;
      try {
        await this.refresh(id);
      } catch (err) {
        this.problem(id, "poll", `Could not check the merge requests (${errorMessage(err)}).`);
      }
    }
  }

  /**
   * A closed task's last MR got merged, so tasks that wait on it with `merged` can go on. Those
   * that were paused for it are told; the owner starts them.
   */
  private async mergedLate(id: string): Promise<void> {
    const { store } = this.deps;
    if (store.tasks.unmergedMrs().has(id) || store.tasks.get(id)?.status !== "done") return;
    for (const link of store.tasks.linksTo(id)) {
      const holder =
        link.type === "depends-on" && link.when !== "ready" ? store.tasks.get(link.task) : undefined;
      if (holder?.status === "paused" && waitsForOwner(holder.pausedReason)) {
        this.note(
          holder.id,
          `Every merge request of ${id} is merged now. Start ${holder.id} when you are ready.`,
        );
      }
    }
    await this.deps.tasks.statusChanged(id);
  }

  /** One command at a time per task, so the timer and a click never merge the same MR twice. */
  private async exclusive<T>(id: string, run: () => Promise<T>): Promise<T>;
  /** With `keys` (see `ShipQueue.key`), the step also waits its turn behind earlier ships into the same project and branch. */
  private async exclusive<T>(id: string, keys: readonly string[], run: () => Promise<T>): Promise<T>;
  private async exclusive<T>(
    id: string,
    a: readonly string[] | (() => Promise<T>),
    b?: () => Promise<T>,
  ): Promise<T> {
    const keys = typeof a === "function" ? [] : a;
    const run = typeof a === "function" ? a : b;
    if (run === undefined) throw new Error("exclusive needs a step to run");
    if (this.busy.has(id))
      throw new UserError(`Another merge request step is running for ${id}. Try again in a moment.`, 409);
    this.busy.add(id);
    try {
      return await this.ships.run(keys, run);
    } finally {
      this.busy.delete(id);
    }
  }
}

interface Plan {
  ctx: RepoContext;
  /** Why this repo sends nothing. */
  skip?: string;
  /** The branch its merge request goes into. */
  into?: string;
}

/** Where a repo's branches are pushed. `pushUrl` is the SSH alias's address, when it differs. */
interface PushTarget {
  /** The project's org: an https push uses its own token when it signed in. */
  org: string;
  remote: string;
  pushUrl: string | undefined;
  /** True when `pushUrl` is https and the computer pushes it with its saved login. */
  viaHost: boolean;
}

/** The ends of the refusals the owner can confirm past; the Ship panel looks for them. */
export const CONFIRM_NEW = "Pushing would create it there. Confirm to create it.";
export const CONFIRM_EXTRA =
  "Pushing would send them with the task. Push them yourself first, or confirm to send them too.";

type ShipResult = {
  project: string;
  into: string;
  ok: boolean;
  detail: string;
  conflicts?: string[] | undefined;
  skipped?: boolean | undefined;
  notPushed?: boolean | undefined;
};

export const HOST_LABEL: Record<MrHost, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
};

/** A failed push in plain words. A refused non-fast-forward says majhi never forces. */
function pushFailure(err: unknown, remote: string, branch: string): string {
  const message = errorMessage(err);
  if (/non-fast-forward|fetch first|\[rejected\]|failed to push some refs/i.test(message)) {
    return `${remote}/${branch} has commits the local ${branch} does not have, so the push was refused. majhi never force-pushes: bring ${branch} up to date first.`;
  }
  return err instanceof PushProblem ? message : `the push failed: ${message}`;
}
