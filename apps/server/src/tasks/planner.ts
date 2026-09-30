import { type AccountView, type AgentFrontmatter, canWorkIn, type Task } from "@majhi/shared";
import type { AccountService } from "../accounts/service.ts";
import type { AgentStore } from "../agents/store.ts";
import { git } from "../git/git.ts";
import type { Store } from "../store/index.ts";
import {
  type AccountLoad,
  type Candidate,
  type Footprint,
  likelyPaths,
  overlapsOf,
  overlapWith,
  type PlanInput,
  planStart,
  sizeOf,
  type TaskOverlap,
  type Verdict,
} from "./planning.ts";

export interface PlannerDeps {
  store: Store;
  agents: AgentStore;
  accounts: AccountService;
  now: () => Date;
}

export interface Plan {
  verdict: Verdict;
  overlaps: TaskOverlap[];
  /** Unmet `depends-on` targets whose tasks share nothing with this one. */
  redundant: string[];
}

const ROLE_RANK: Record<string, number> = { Lead: 0, Builder: 1 };

/** Gathers what `planStart` needs from the real tasks, worktrees and accounts. */
export class TaskPlanner {
  constructor(private readonly deps: PlannerDeps) {}

  /** Files a task changed in its worktrees, plus what its description names, per project. */
  async footprints(task: Task): Promise<Footprint[]> {
    const named = likelyPaths(`${task.title}\n${task.brief}`);
    const out: Footprint[] = [];
    for (const repo of task.repos) {
      const changed = repo.worktree === undefined ? [] : await changedFiles(repo.worktree, repo.base);
      const paths = [...new Set([...changed, ...named])];
      out.push({ task: task.id, project: repo.project, paths, changed: changed.length > 0 });
    }
    return out;
  }

  /** The tasks running now, other than `except`. */
  running(except: string): Task[] {
    return this.deps.store.tasks
      .list(false)
      .filter((t) => t.status === "running" && t.id !== except)
      .flatMap((t) => this.deps.store.tasks.get(t.id) ?? []);
  }

  async plan(task: Task): Promise<Plan> {
    const running = this.running(task.id);
    const named = likelyPaths(`${task.title}\n${task.brief}`);
    const likely = new Map(task.repos.map((r) => [r.project, named]));
    const footprints = (await Promise.all(running.map((t) => this.footprints(t)))).flat();
    const overlaps = overlapsOf(likely, footprints);

    // Links that only hold the task back: the target shares nothing with it.
    const redundant: string[] = [];
    for (const link of task.links) {
      if (link.type !== "depends-on") continue;
      const target = this.deps.store.tasks.get(link.task);
      if (target === undefined || target.status === "done") continue;
      if (task.brief.includes(target.id)) continue;
      const sameProjects = target.repos.some((r) => task.repos.some((m) => m.project === r.project));
      if (!sameProjects && task.repos.length > 0 && target.repos.length > 0) {
        redundant.push(target.id);
        continue;
      }
      const theirs = (await this.footprints(target)).flatMap((f) => f.paths);
      const level = overlapWith(named, theirs).level;
      if (level === "none") redundant.push(target.id);
    }

    const stored = await this.deps.agents.list();
    const agents = stored.flatMap((a) => (a.ok ? [a.agent.frontmatter] : []));
    const views = new Map((await this.deps.accounts.list()).map((v) => [v.id, v]));
    const lead = agents.find((a) => a.id === task.team[0]);
    if (lead === undefined) return { verdict: { action: "start" }, overlaps, redundant };

    const load = (account: string): AccountLoad => {
      const usage = views.get(account)?.usage;
      const busy = running.filter((t) => accountOf(t, agents) === account).length;
      // A failed read keeps the last good numbers; no numbers at all (API key) means it always fits.
      return { usage: usage ?? null, running: busy };
    };
    const input: PlanInput = {
      size: sizeOf(task.brief, named),
      agent: { agent: lead.id, account: lead.account },
      alternatives: alternatives(task, agents, views),
      load,
      overlaps,
      running: running.map((t) => ({
        id: t.id,
        runningMs: Math.max(0, this.deps.now().getTime() - Date.parse(t.updatedAt)),
      })),
    };
    return { verdict: planStart(input), overlaps, redundant };
  }
}

function accountOf(task: Task, agents: readonly AgentFrontmatter[]): string | undefined {
  return agents.find((a) => a.id === task.team[0])?.account;
}

/** Agents that could take the task on another account: Leads and Builders that may work in its org, usable accounts first. */
function alternatives(
  task: Task,
  agents: readonly AgentFrontmatter[],
  views: ReadonlyMap<string, AccountView>,
): Candidate[] {
  return agents
    .filter((a) => a.id !== task.team[0] && a.role in ROLE_RANK && canWorkIn(a, task.org))
    .filter((a) => {
      const status = views.get(a.account)?.status ?? "unknown";
      return status !== "needs-login" && status !== "at-limit" && status !== "unreachable";
    })
    .sort((a, b) => (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9))
    .map((a) => ({ agent: a.id, account: a.account }));
}

/** Files changed from the fork point to the working tree, plus new files. Empty when git says nothing. */
async function changedFiles(worktree: string, base: string): Promise<string[]> {
  const fork = (await git(worktree, ["merge-base", "HEAD", base]).catch(() => "")).trim() || "HEAD";
  const diff = await git(worktree, ["diff", "--name-only", fork]).catch(() => "");
  const fresh = await git(worktree, ["ls-files", "--others", "--exclude-standard"]).catch(() => "");
  return [
    ...new Set(
      `${diff}\n${fresh}`
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
}
