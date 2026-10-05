import type { BaseEnv, RunMount, Spawner } from "@majhi/acp";
import { PRIVATE, type Task } from "@majhi/shared";
import type Database from "better-sqlite3";
import { git } from "../git/git.ts";
import type { Housekeeper } from "../memory/housekeeper.ts";
import type { MrService } from "../mrs/service.ts";
import type { ProjectCards } from "../projectcard/service.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import type { TaskService } from "../tasks/service.ts";
import { type DiffFacts, parseReview, tokensOf } from "./analysis.ts";
import { type ExecDeps, execInTask } from "./exec.ts";
import { defaultHandoffParallel } from "./limits.ts";
import { shipReadiness } from "./ready.ts";
import { HandoffRepo } from "./repo.ts";
import { type HandoffLimits, type HandoffOptions, type HandoffPorts, HandoffService } from "./service.ts";

export interface HandoffWiring {
  db: Database.Database;
  store: Store;
  tasks: TaskService;
  mrs: MrService;
  room: RoomService;
  runs: { working(task: string): string[] };
  projectCards: ProjectCards;
  housekeeper: Housekeeper;
  spawner: Spawner;
  base: BaseEnv;
  repoMounts: (task: Task) => Promise<RunMount[]>;
  /** The workspace's shared package store for a check: see `ExecDeps.packages`. */
  packages?: ExecDeps["packages"];
  /** The check's `docker` shim: see `ExecDeps.dockerShim`. */
  dockerShim?: ExecDeps["dockerShim"];
  /** The workspace's Merge row is Captain: only then does the captain have a lead resolve a conflict. */
  mergeDecides: (org: string) => Promise<boolean>;
  /** Autonomous is on. */
  autonomous: () => boolean;
  /** The owner switched an outcome rule off in a workspace. Bound late: the playbooks come after the hand-off. */
  ruleOff?: ((org: string, rule: string) => boolean) | undefined;
  /** The monthly ceiling is reached, in words, or undefined. Bound late. */
  ceilingHeld: () => string | undefined;
  changed: (task: string) => void;
  now?: (() => Date) | undefined;
  options?: HandoffOptions | undefined;
  /** What a check runs in, for retrying a failure after an update: majhi's commit and the runner image. */
  environment?: (() => string) | undefined;
  /** The caps and timeouts of a project's checks, from settings. */
  limits?: ((project: string) => Promise<HandoffLimits>) | undefined;
  /** Tests replace the command runner. */
  exec?: HandoffPorts["exec"] | undefined;
}

/** The task's head commits, one per repo: the branch tips, so a state of the work is one string. */
export async function taskHeads(task: Task): Promise<string> {
  const heads: string[] = [];
  for (const r of task.repos) {
    const tip = (
      await git(r.source, ["rev-parse", "--verify", `refs/heads/${r.branch}`]).catch(() => "")
    ).trim();
    heads.push(`${r.project}@${tip.slice(0, 12)}`);
  }
  return heads.join(",");
}

/** The real pieces behind the hand-off: majhi's own services, the task's runner and the cheapest model. */
export function createHandoff(w: HandoffWiring): HandoffService {
  const ports: HandoffPorts = {
    task: (id) => {
      const t = w.store.tasks.get(id);
      return t === undefined
        ? undefined
        : {
            id: t.id,
            title: t.title,
            brief: t.brief,
            org: t.org ?? PRIVATE,
            status: t.status,
            repos: t.repos.map((r) => ({ project: r.project, worktree: r.worktree })),
          };
    },
    heads: async (id) => {
      const t = w.store.tasks.get(id);
      return t === undefined ? "" : taskHeads(t);
    },
    ready: async (id) => {
      // A done task can still be merged (its work was never shipped): its tests and build must run
      // for the merge rule, and the review-state checks below do not apply to it.
      if (w.store.tasks.get(id)?.status === "done") {
        return { ok: true, evidence: "the task is done: the review-state checks do not apply" };
      }
      const r = await shipReadiness(w, id);
      if (r.ready) return { ok: true, evidence: r.evidence };
      // Resolving a conflict follows the Merge row: where the owner decides, it is the owner's.
      const org = w.store.tasks.get(id)?.org ?? PRIVATE;
      const owner = r.owner === true || (r.conflict === true && !(await w.mergeDecides(org)));
      return { ok: false, why: r.why, ...(owner ? { owner: true } : {}) };
    },
    commands: (project) => w.projectCards.get(project)?.commands ?? {},
    diff: async (id): Promise<DiffFacts> => {
      const diffs = await w.tasks.diff(id);
      return {
        files: diffs.flatMap((d) =>
          d.files.map((f) => ({
            project: d.project,
            path: f.path,
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch,
          })),
        ),
        commits: diffs.flatMap((d) => d.commits.map((c) => c.subject)),
      };
    },
    ...(w.environment === undefined ? {} : { environment: w.environment }),
    ...(w.limits === undefined ? {} : { limits: w.limits }),
    exec:
      w.exec ??
      execInTask({
        spawner: w.spawner,
        base: w.base,
        task: (id) => w.store.tasks.get(id),
        repoMounts: w.repoMounts,
        packages: w.packages,
        dockerShim: w.dockerShim,
      }),
    review: async (task, prompt) => {
      const { value } = await w.housekeeper.ask({ id: task.id, org: task.org }, prompt, parseReview);
      return { gaps: value, tokens: tokensOf(prompt, value.join("\n")) };
    },
    autonomous: w.autonomous,
    ruleOff: (org, rule) => w.ruleOff?.(org, rule) === true,
    modelBlocked: () => w.ceilingHeld(),
    tell: (id, text) => w.tasks.handoffTell({ task: id, text }),
    hold: (id, line) => {
      w.tasks.cards.checkHeld(id, line);
    },
    changed: w.changed,
    ...(w.now === undefined ? {} : { now: w.now }),
  };
  return new HandoffService(ports, new HandoffRepo(w.db), {
    parallel: defaultHandoffParallel(),
    ...w.options,
  });
}
