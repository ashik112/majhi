import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BaseEnv, RunMount, Spawner } from "@majhi/acp";
import { type HandoffCommands, PRIVATE, type Task } from "@majhi/shared";
import type Database from "better-sqlite3";
import { z } from "zod";
import { readCiChecks } from "../ci/checks.ts";
import { git } from "../git/git.ts";
import { changeBase } from "../git/since-start.ts";
import type { Housekeeper } from "../memory/housekeeper.ts";
import type { MrService } from "../mrs/service.ts";
import { fsRepoFiles } from "../projectcard/files.ts";
import type { ProjectCards } from "../projectcard/service.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import type { TaskService } from "../tasks/service.ts";
import { type DiffFacts, parseReview, tokensOf } from "./analysis.ts";
import { baseRunStore } from "./base-runs.ts";
import { makeCheckout } from "./checkout.ts";
import { effectiveCommands } from "./commands.ts";
import { type ExecDeps, execInTask } from "./exec.ts";
import { dependenciesMissing } from "./install.ts";
import { defaultHandoffParallel } from "./limits.ts";
import { pruneRuns, writeStepLog } from "./logs.ts";
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
  /** The workspace's tools folder: see `ExecDeps.tools`. */
  tools?: ExecDeps["tools"];
  /** The check's `docker` shim: see `ExecDeps.dockerShim`. */
  dockerShim?: ExecDeps["dockerShim"];
  /** The ship decision leaves the merge of this task to the captain: only then does it have a lead resolve a conflict. */
  mergeDecides: (task: string) => Promise<boolean>;
  /** Autonomous is on. */
  autonomous: () => boolean;
  /** The owner switched an outcome rule off in a workspace. Bound late: the playbooks come after the hand-off. */
  ruleOff?: ((org: string, rule: string) => boolean) | undefined;
  /** A project's own hand-off commands from majhi.yaml, when set. They win over its card's. */
  handoffCommands?: ((project: string) => Promise<HandoffCommands | undefined>) | undefined;
  /** The monthly ceiling is reached, in words, or undefined. Bound late. */
  ceilingHeld: () => string | undefined;
  changed: (task: string) => void;
  now?: (() => Date) | undefined;
  options?: HandoffOptions | undefined;
  /** What a check runs in, for retrying a failure after an update: majhi's commit and the runner image. */
  environment?: (() => string) | undefined;
  /** The caps and timeouts of a project's checks, from settings. */
  limits?: ((project: string) => Promise<HandoffLimits>) | undefined;
  /** Where the results of checks on base commits are kept. Absent: they are run again each time. */
  baseRunsDir?: string | undefined;
  /** Files a finding for a check that already fails on the base, once per project and check. */
  reportExisting?: HandoffPorts["reportExisting"] | undefined;
  /** Tests replace the command runner. */
  exec?: HandoffPorts["exec"] | undefined;
}

/** Files whose change means what a project installs may differ. */
const INSTALL_FILES: ReadonlySet<string> = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "poetry.lock",
  "Pipfile.lock",
  "composer.json",
  "composer.lock",
]);

const PackageSchema = z.looseObject({ scripts: z.record(z.string(), z.string()).optional() });

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
      if (r.unmergeable === "empty") return { ok: false, why: r.why, empty: true };
      // Resolving a conflict follows who merges this task: where the owner does, it is the owner's.
      const owner = r.owner === true || (r.conflict === true && !(await w.mergeDecides(id)));
      return { ok: false, why: r.why, ...(owner ? { owner: true } : {}) };
    },
    commands: async (project) =>
      effectiveCommands(w.projectCards.get(project)?.commands, await w.handoffCommands?.(project)),
    checkSpec: async (_task, project, kind, worktree) => {
      const key = kind === "tests" ? "test" : kind;
      const own = (await w.handoffCommands?.(project))?.[key];
      if (own !== undefined && own.trim() !== "")
        return { command: own, env: {}, from: "set for this project" };
      // The CI of the task's own commit, so a CI file the task changed counts.
      if (key !== "install") {
        const found = (await readCiChecks(fsRepoFiles(worktree), { fresh: true })).find((c) => c.kind === key);
        if (found !== undefined)
          return {
            command: found.command,
            env: found.env,
            workdir: found.workdir,
            from: found.from,
            minutes: found.minutes,
            services: found.services,
          };
      }
      const card = w.projectCards.get(project)?.commands[key];
      return card === undefined || card.trim() === ""
        ? undefined
        : { command: card, env: {}, from: "from the project card" };
    },
    script: async (cwd, name) => {
      try {
        const pkg = PackageSchema.safeParse(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")));
        return pkg.success ? pkg.data.scripts?.[name] : undefined;
      } catch {
        return undefined;
      }
    },
    headCommit: async (id, project) => {
      const r = w.store.tasks.get(id)?.repos.find((x) => x.project === project);
      if (r === undefined) return undefined;
      const tip = (
        await git(r.source, ["rev-parse", "--verify", `refs/heads/${r.branch}`]).catch(() => "")
      ).trim();
      return tip === "" ? undefined : tip;
    },
    checkout: async (id, project, commit, installedFrom) => {
      const t = w.store.tasks.get(id);
      const r = t?.repos.find((x) => x.project === project);
      if (t === undefined || r === undefined) throw new Error("the task is gone");
      return makeCheckout({ source: r.source, folder: t.folder, project, commit, installedFrom });
    },
    dependenciesChanged: async (id, project, base) => {
      const r = w.store.tasks.get(id)?.repos.find((x) => x.project === project);
      if (r === undefined) return false;
      const out = await git(r.source, ["diff", "--name-only", base, `refs/heads/${r.branch}`]);
      return out.split("\n").some((file) => INSTALL_FILES.has(file.split("/").pop() ?? ""));
    },
    ...(w.baseRunsDir === undefined ? {} : { baseRuns: baseRunStore(w.baseRunsDir) }),
    ...(w.reportExisting === undefined ? {} : { reportExisting: w.reportExisting }),
    mergeBase: async (id, project) => {
      const t = w.store.tasks.get(id);
      const r = t?.repos.find((x) => x.project === project);
      if (r === undefined) return undefined;
      const cwd = r.worktree ?? r.source;
      const from = await changeBase(cwd, r, `refs/heads/${r.branch}`, { mergeBase: true }).catch(
        () => undefined,
      );
      return from?.commit;
    },
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
    needsInstall: dependenciesMissing,
    saveLog: async (id, run, step, text) => {
      const folder = w.store.tasks.get(id)?.folder;
      if (folder === undefined) throw new Error("the task is gone");
      await writeStepLog(folder, run, step, text);
      await pruneRuns(folder);
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
        tools: w.tools,
        dockerShim: w.dockerShim,
      }),
    review: async (task, prompt) => {
      const { value } = await w.housekeeper.ask({ id: task.id, org: task.org }, prompt, parseReview);
      return { gaps: value, tokens: tokensOf(prompt, value.join("\n")) };
    },
    autonomous: w.autonomous,
    ruleOff: (org, rule) => w.ruleOff?.(org, rule) === true,
    modelBlocked: () => w.ceilingHeld(),
    tell: (id, text, failed) => w.tasks.handoffTell({ task: id, text, failed }),
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
