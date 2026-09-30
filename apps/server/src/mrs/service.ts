import { randomUUID } from "node:crypto";
import {
  DEFAULT_MERGE_POLICY,
  type MarkMergedResult,
  type MergeMrsResult,
  type MergeOrder,
  type MergePolicy,
  type MrHost,
  type OpenMrsResult,
  type ProjectLink,
  type RefreshMrsResult,
  type RemoteConfig,
  type RepoMr,
  type Task,
  type TaskRepo,
} from "@majhi/shared";
import type { ConfigService } from "../config/service.ts";
import { errorMessage, UserError } from "../errors.ts";
import type { EventHub } from "../events/hub.ts";
import { FETCH_TIMEOUT_MS, git, uncommitted } from "../git/git.ts";
import { isSshAuthFailure, removeWorktree } from "../git/worktrees.ts";
import type { ProjectInfo, ProjectService } from "../projects/service.ts";
import type { RoomService } from "../room/service.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { Store } from "../store/index.ts";
import type { TaskService } from "../tasks/service.ts";
import { mrTitle, renderMrDescription } from "./description.ts";
import type { MrHostClient, MrTarget } from "./hosts/index.ts";
import { MergeOrderCycle, mergeOrder, orderViolations, type ProjectGraph } from "./order.ts";
import { nextMerge, type RepoMrState } from "./policy.ts";
import { commitsAhead, pushBranch, remoteUrl } from "./push.ts";
import { hostNameOf, mrHostOf, mrRemoteName, repoSlug, rewriteRemoteUrl } from "./remote.ts";

export interface MrDeps {
  store: Store;
  config: ConfigService;
  projects: ProjectService;
  secrets: SecretStore;
  room: RoomService;
  events: EventHub;
  tasks: Pick<TaskService, "get" | "close" | "statusChanged">;
  /** True while an agent of the task works. */
  working: (task: string) => boolean;
  hosts: Record<MrHost, MrHostClient>;
  /** Asks the host helper to load the owner's SSH keys again, after a push or fetch they lacked. */
  reloadKeys?: () => Promise<boolean>;
  now?: () => Date;
}

/** Everything one repo needs to talk to its remote and its MR host. */
interface RepoContext {
  repo: TaskRepo;
  project: ProjectInfo;
  remote: string;
  remoteConfig: RemoteConfig | undefined;
  pushUrl: string | undefined;
  target: Omit<MrTarget, "token">;
  client: MrHostClient;
}

/** Pushing, opening, watching and merging the MRs of a task's repos (SPEC 5.5). */
export class MrService {
  private readonly busy = new Set<string>();
  /** Problems already said in the room, by task and kind, so a poll that fails the same way stays quiet. */
  private readonly said = new Map<string, string>();

  constructor(private readonly deps: MrDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private note(task: string, text: string, level: "info" | "error" = "info"): void {
    this.deps.room.post(task, `${level}:${randomUUID()}`, { type: "system", level, text });
  }

  /** Says a problem once until it changes or clears. */
  private problem(task: string, key: string, text: string): void {
    if (this.said.get(`${task}|${key}`) === text) return;
    this.said.set(`${task}|${key}`, text);
    this.note(task, text, "error");
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
      return { repos: order.flatMap((p) => task.repos.filter((r) => r.project === p)), overridden: false };
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
    const value = await this.deps.secrets.get(name).catch(() => undefined);
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
    const pushUrl = rewriteRemoteUrl(url, remoteConfig?.ssh);
    return {
      repo,
      project,
      remote,
      remoteConfig,
      pushUrl: pushUrl === url ? undefined : pushUrl,
      target: { host, slug: repoSlug(url), ...(hostName === undefined ? {} : { hostName }) },
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
  async open(id: string): Promise<OpenMrsResult> {
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
      const plans = await this.preflight(repos);
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
          results.push({ project, outcome: "skipped", detail: "Not tried: an earlier repo failed." });
          continue;
        }
        try {
          const target = await this.targetOf(ctx);
          const worktree = ctx.repo.worktree as string;
          await pushBranch({
            worktree,
            remote: ctx.remote,
            branch: ctx.repo.branch,
            url: ctx.pushUrl,
            reloadKeys: this.deps.reloadKeys,
          });
          this.deps.store.tasks.setPushed(id, project, this.now().toISOString());
          const existing = this.deps.store.tasks.get(id)?.repos.find((r) => r.project === project)?.mr;
          if (existing !== undefined && existing.state === "open") {
            opened.push({ ctx, target, number: existing.number });
            results.push({
              project,
              outcome: "updated",
              url: existing.url,
              detail: `Pushed ${ctx.repo.branch}; the merge request is already open.`,
            });
            continue;
          }
          const body = this.body(task, project, this.siblings(id, plans));
          const mr = await ctx.client.open(target, {
            head: ctx.repo.branch,
            base: ctx.repo.base,
            title: mrTitle(task.id, task.title),
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
          results.push({ project, outcome: "failed", detail: errorMessage(err) });
        }
      }

      // Every MR is open now, so each description can name all of them.
      for (const { ctx, target, number } of opened) {
        try {
          const project = ctx.project.id;
          await ctx.client.updateDescription(target, number, {
            title: mrTitle(task.id, task.title),
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
      const anyMr = this.deps.store.tasks.get(id)?.repos.some((r) => r.mr !== undefined) === true;
      if (!failed && anyMr) {
        if (task.status !== "mr") {
          this.deps.store.tasks.setStatus(id, "mr", undefined, this.now().toISOString());
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

  private body(
    task: Task,
    project: string,
    siblings: { project: string; url?: string | undefined }[],
  ): string {
    return renderMrDescription({ taskId: task.id, title: task.title, brief: task.brief, project, siblings });
  }

  /** Checks every repo before anything is pushed, so a problem in the last one does not leave the first half sent. */
  private async preflight(repos: readonly TaskRepo[]): Promise<Plan[]> {
    const plans: Plan[] = [];
    for (const repo of repos) {
      const ctx = await this.context(repo);
      const project = ctx.project.id;
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
      const ahead = await commitsAhead(repo.source, repo.base, ctx.remote, repo.branch).catch(() => 0);
      const hasMr = repo.mr !== undefined;
      plans.push(
        ahead === 0 && !hasMr
          ? { ctx, skip: `${repo.branch} has no commits past ${repo.base}, so there is nothing to merge.` }
          : { ctx },
      );
    }
    if (plans.every((p) => p.skip !== undefined)) {
      throw new UserError("No repo of this task has a commit to send.", 409);
    }
    return plans;
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
        };
        if (next.state !== repo.mr.state || next.ci !== repo.mr.ci || next.url !== repo.mr.url) {
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
    return this.exclusive(id, async () => {
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
        const decision = nextMerge({ policy, trigger, order, nowMs: this.now().getTime() });
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
        try {
          const ctx = await this.context(repo);
          const target = await this.targetOf(ctx);
          await ctx.client.merge(target, repo.mr.number);
          const status = await ctx.client.status(target, repo.mr.number);
          this.deps.store.tasks.setMr(id, repo.project, {
            url: status.url || repo.mr.url,
            number: repo.mr.number,
            state: status.state,
            ci: status.ci,
          });
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
          this.deps.store.tasks.setMr(input.id, repo.project, { ...repo.mr, state: "merged" });
          this.note(input.id, `${repo.project}: recorded as merged, as the owner said.`);
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
    await this.deps.tasks.close(task.id);
  }

  private async fetchBase(source: string, remote: string, base: string): Promise<string | undefined> {
    const attempt = async (): Promise<string | undefined> => {
      try {
        await git(source, ["fetch", "--quiet", remote, base], { timeoutMs: FETCH_TIMEOUT_MS });
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
      if (holder?.status === "paused" && holder.pausedReason === "owner") {
        this.note(
          holder.id,
          `Every merge request of ${id} is merged now. Start ${holder.id} when you are ready.`,
        );
      }
    }
    await this.deps.tasks.statusChanged(id);
  }

  /** One command at a time per task, so the timer and a click never merge the same MR twice. */
  private async exclusive<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (this.busy.has(id))
      throw new UserError(`Another merge request step is running for ${id}. Try again in a moment.`, 409);
    this.busy.add(id);
    try {
      return await run();
    } finally {
      this.busy.delete(id);
    }
  }
}

interface Plan {
  ctx: RepoContext;
  /** Why this repo sends nothing. */
  skip?: string;
}
