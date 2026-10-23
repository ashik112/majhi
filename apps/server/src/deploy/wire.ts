import {
  type DeployRecord,
  deployPhase,
  type HomeDeploy,
  PRIVATE,
  type ProjectDeployView,
} from "@majhi/shared";
import { auditActor, auditDetail } from "../audit.ts";
import type { DeployHeld, DeployNext, DeployPorts } from "../captain/ports.ts";
import type { ConfigService } from "../config/service.ts";
import { type RemoteRunFn, runRemote } from "../connections/remote.ts";
import { git } from "../git/git.ts";
import type { Fetch } from "../gitConnect/http.ts";
import { remoteUrl } from "../mrs/push.ts";
import { mrHostOf, mrRemoteName, realHostOf, repoSlug } from "../mrs/remote.ts";
import type { ProjectInfo, ProjectService } from "../projects/service.ts";
import { loadSshConfig } from "../scan/sshConfig.ts";
import type { ShipPlanner } from "../ship/plan.ts";
import type { Store } from "../store/index.ts";
import type { TaskService } from "../tasks/service.ts";
import { createBitbucketProvider } from "./bitbucket.ts";
import { type CredentialDeps, createDeployCredentials } from "./credentials.ts";
import { DeployDiscovery } from "./discovery.ts";
import { deployGit } from "./git.ts";
import { createGitHubProvider } from "./github.ts";
import { createGitLabProvider } from "./gitlab.ts";
import type { NothingDeploys } from "./nothing.ts";
import { DeployPlanner } from "./plan.ts";
import { type DeployDeps, type DeployProject, DeployService } from "./service.ts";
import { createSshProvider } from "./ssh.ts";
import { DeploySync, type DeploySyncDeps, heldSteps } from "./sync.ts";
import type { ProviderDeps, Providers, RepoRef } from "./types.ts";
import { createVercelProvider } from "./vercel.ts";

/** Work merged this long ago is still deployed by the rules; older work is left alone. */
export const DEPLOY_WINDOW_MS = 3 * 86_400_000;

/** How long the deploy service looks at a run, and at the check, and how long a run may take. */
export interface DeployTiming {
  pollMs: number;
  verifyMs: number;
  runTimeoutMs: number;
  /** How long the check after the runs lasts. */
  checkSeconds: number;
}

export const DEFAULT_TIMING: DeployTiming = {
  pollMs: 5_000,
  verifyMs: 5_000,
  runTimeoutMs: 30 * 60_000,
  checkSeconds: 60,
};

export interface DeployWorldDeps {
  store: Store;
  config: ConfigService;
  projects: ProjectService;
  tasks: Pick<TaskService, "create" | "get">;
  ship: Pick<ShipPlanner, "plan">;
  /** The captain's answer "nothing deploys", kept in its log. */
  nothing: NothingDeploys;
  credentials: CredentialDeps;
  checksConfigured: (project: string) => boolean | Promise<boolean>;
  tellOwner: (key: string, text: string, org?: string) => void;
  /** One line for the workspace's log: what majhi found about how a project deploys. */
  said?: ((org: string, text: string) => void) | undefined;
  /** Opens or joins the incident of a failed deploy (the incident engine). Absent: the task is made here. */
  incident?:
    | ((input: {
        org: string;
        project: string;
        record: DeployRecord;
        title: string;
        text: string;
      }) => Promise<string | undefined>)
    | undefined;
  /** One line in a task's room. */
  taskNote: (task: string, key: string, level: "info" | "warn", text: string) => void;
  /** A deploy went live: the captain's ship chore of the workspace looks again. */
  onLive: (org: string) => void;
  changed: () => void;
  fetch?: Fetch | undefined;
  remote?: RemoteRunFn | undefined;
  vercelApi?: string | undefined;
  /** Sends the base branch to a remote that deploys (a fast-forward, never forced) when it lacks the commit. */
  publish?: DeployDeps["publish"] | undefined;
  /** Reads a project's remotes' base branch again from where they live. A sentence when one could not be read. */
  refresh?: DeploySyncDeps["refresh"] | undefined;
  /** What the task's own agent is woken with when a deploy remote is ahead. Absent: that step is only said. */
  syncTasks?: DeploySyncDeps["tasks"] | undefined;
  /**
   * Runs a finished task's whole deploy plan as the captain, through the case deployer, and answers with the first
   * target's record once it exists. Absent: the captain starts one planned record at a time.
   */
  runTask?: ((task: string) => Promise<{ record: DeployRecord; repeat: boolean } | undefined>) | undefined;
  timing?: Partial<DeployTiming> | undefined;
  now?: (() => Date) | undefined;
}

export interface DeployWorld {
  service: DeployService;
  planner: DeployPlanner;
  /** Reads a project's CI files and saves the environments it deploys through. */
  discovery: DeployDiscovery;
  /** What the captain's ship chore reads and does. */
  ports: DeployPorts;
  /** The project's page: environments and history. */
  view(project: string): Promise<ProjectDeployView>;
  /** The deploy steps of recently merged tasks that are not all live yet, for the board. Kept briefly. */
  board(): Promise<HomeDeploy[]>;
  /** The files a task changed in a project (its branch since it was cut), or undefined when git cannot say. */
  changed(task: string, project: string): Promise<string[] | undefined>;
}

const HEALTH_TIMEOUT_MS = 10_000;
/** The board's deploy facts are kept this long, and cover at most this many tasks. */
const BOARD_KEEP_MS = 5_000;
const BOARD_TASKS = 40;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function projectOf(p: ProjectInfo): DeployProject {
  return { id: p.id, org: p.org, path: p.path, base: p.base, remotes: p.remotes, environments: p.deploy };
}

/** The host a provider is reached at when the remote has no host name of its own (a local path or an alias with no entry). */
const PUBLIC_HOST = { github: "github.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org" } as const;

export function createDeploy(deps: DeployWorldDeps): DeployWorld {
  const now = deps.now ?? (() => new Date());
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  const providerDeps: ProviderDeps = {
    fetch: deps.fetch ?? fetch,
    credentials: createDeployCredentials(deps.credentials),
    remote: deps.remote ?? runRemote,
    sleep,
    now,
    vercelApi: deps.vercelApi,
  };
  const gitlab = createGitLabProvider(providerDeps);
  const providers: Providers = {
    "github-workflow": createGitHubProvider(providerDeps),
    "gitlab-pipeline": gitlab,
    "gitlab-job": gitlab,
    "gitlab-merge": gitlab,
    "bitbucket-pipeline": createBitbucketProvider(providerDeps),
    vercel: createVercelProvider(providerDeps),
    ssh: createSshProvider(providerDeps),
  };

  const project = async (id: string): Promise<DeployProject> => projectOf(await deps.projects.get(id));

  const repoRef = async (p: DeployProject, named?: string): Promise<RepoRef | undefined> => {
    const remote = named ?? mrRemoteName(p.remotes);
    const url = await remoteUrl(p.path, remote).catch(() => undefined);
    if (url === undefined) return undefined;
    const ssh = await loadSshConfig(deps.config.paths.hostHome);
    // The workspace's git account is for the real host: an ssh alias is looked up in the owner's ssh config.
    const real = realHostOf(url, ssh);
    const account = (await deps.config.sections()).orgs[p.org]?.git_accounts?.some((a) => a.host === real);
    const provider = mrHostOf(url, ssh, account === true);
    if (provider === undefined) return undefined;
    return { provider, slug: repoSlug(url), host: real ?? PUBLIC_HOST[provider] };
  };

  /** Opens the incident task of a failed deploy: typed `incident`, its origin the deploy, in the deploy's workspace. */
  const openIncident = async (input: {
    org: string;
    project: string;
    record: DeployRecord;
    title: string;
    text: string;
  }): Promise<string | undefined> => {
    if (deps.incident !== undefined) return deps.incident(input);
    const origin = {
      kind: "deploy" as const,
      deploy: input.record.id,
      project: input.project,
      env: input.record.env,
    };
    const base = {
      text: input.text,
      title: input.title,
      attachments: [],
      start: false,
      provenance: { kind: "ref" as const, origin, workspace: input.org },
      gate: "incident" as const,
      typing: { type: "incident" as const, by: "captain" as const },
    };
    try {
      return (await deps.tasks.create({ ...base, repos: [{ project: input.project }] })).id;
    } catch {
      // A protected project cannot join a task: the incident reads it instead of changing it.
      try {
        return (await deps.tasks.create({ ...base, repos: [{ project: input.project }], readOnly: true })).id;
      } catch {
        return undefined;
      }
    }
  };

  /**
   * The files a task changed in a project: the branch since the commit it was cut from, else what its landing commit
   * brought. A branch that merged still has its tip, so the range is read after the merge too.
   */
  const changed = async (taskId: string, projectId: string): Promise<string[] | undefined> => {
    const repo = deps.store.tasks.get(taskId)?.repos.find((r) => r.project === projectId);
    const info = await deps.projects.get(projectId).catch(() => undefined);
    if (repo === undefined || info === undefined) return undefined;
    const range =
      repo.startCommit !== undefined && repo.shipped !== undefined
        ? [`${repo.startCommit}...${repo.shipped.head}`]
        : repo.landed !== undefined
          ? [`${repo.landed.commit}^1`, repo.landed.commit]
          : undefined;
    if (range === undefined) return undefined;
    try {
      const out = await git(info.path, ["diff", "--name-only", ...range]);
      return out.split("\n").filter((p) => p !== "");
    } catch {
      return undefined;
    }
  };

  const service: DeployService = new DeployService({
    repo: deps.store.deploys,
    changedIn: changed,
    projects: { get: project },
    tasks: {
      get: (id) => {
        const t = deps.store.tasks.get(id);
        return t === undefined ? undefined : { id: t.id, org: t.org };
      },
      landedCommits: (id) => new Set(deps.store.tasks.landings(id, 200).map((l) => l.commit)),
    },
    git: deployGit,
    ...(deps.refresh === undefined
      ? {}
      : { refresh: (p: DeployProject, remotes: readonly string[], base: string) => deps.refresh?.(p.id, remotes, base) ?? Promise.resolve(undefined) }),
    repoRef,
    checksConfigured: deps.checksConfigured,
    providers,
    providerDeps,
    ...(deps.publish === undefined ? {} : { publish: deps.publish }),
    looks: {
      health: async (url) => {
        try {
          const res = await (deps.fetch ?? fetch)(url, {
            redirect: "manual",
            signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
          });
          await res.body?.cancel().catch(() => undefined);
          return { status: res.status };
        } catch {
          return undefined;
        }
      },
    },
    openIncident,
    tellOwner: (org, key, text) => deps.tellOwner(key, text, org),
    audit: (row) => {
      deps.store.permissions.log({
        task: row.task,
        ...auditActor(row.by === "owner" ? "owner" : "majhi"),
        kind: "deploy",
        title: row.title,
        decision: row.ok ? "done" : "failed",
        at: now().toISOString(),
        detail: auditDetail(row.detail),
        org: row.org,
      });
    },
    changed: deps.changed,
    onLive: (record) => deps.onLive(record.org),
    taskNote: deps.taskNote,
    nothingDeploys: async (id, by) => {
      const task = deps.store.tasks.get(id);
      if (task !== undefined) await deps.nothing.record(task, by);
    },
    now,
    sleep,
    ...timing,
  });

  const planner = new DeployPlanner({
    service,
    repo: deps.store.deploys,
    ship: (id) => deps.ship.plan(id),
    environments: async (id) => (await deps.projects.get(id).catch(() => undefined))?.deploy ?? [],
  });

  const next = async (org: string): Promise<DeployNext[]> => {
    const since = new Date(now().getTime() - DEPLOY_WINDOW_MS).toISOString();
    const out = new Map<string, DeployNext>();
    for (const id of deps.store.tasks.landedSince(since)) {
      const task = deps.store.tasks.get(id);
      if (task === undefined || (task.org ?? PRIVATE) !== org) continue;
      const steps = await planner.stepsOf(task).catch(() => []);
      for (const s of steps) {
        if (
          (s.state !== "captain-next" && s.state !== "waits-for-owner") ||
          s.commit === undefined ||
          s.record === undefined
        ) {
          continue;
        }
        const key = `${s.project}:${s.env}:${s.commit}`;
        if (out.has(key)) continue;
        out.set(key, {
          task: id,
          title: task.title,
          project: s.project,
          env: s.env,
          record: s.record,
          commit: s.commit,
          who: s.who,
        });
      }
    }
    return [...out.values()];
  };

  /** Steps of work merged lately that cannot go and that majhi clears itself: a deploy remote that is ahead, or a wait. */
  const held = async (org: string): Promise<DeployHeld[]> => {
    const since = new Date(now().getTime() - DEPLOY_WINDOW_MS).toISOString();
    const out: DeployHeld[] = [];
    for (const id of deps.store.tasks.landedSince(since)) {
      const task = deps.store.tasks.get(id);
      if (task === undefined || (task.org ?? PRIVATE) !== org) continue;
      out.push(...heldSteps(task, await planner.stepsOf(task).catch(() => [])));
    }
    return out;
  };

  const sync =
    deps.syncTasks === undefined || deps.refresh === undefined
      ? undefined
      : new DeploySync({
          tasks: deps.syncTasks,
          refresh: deps.refresh,
          note: deps.taskNote,
        });

  const ports: DeployPorts = {
    next,
    held,
    async prepare(_org, step) {
      await sync?.prepare(step);
    },
    async needsPlan(_org, id) {
      const task = deps.store.tasks.get(id);
      // Planned means it has deploy records, or the plan came back empty for this head of the work.
      if (task === undefined || deps.store.deploys.ofTask(id).length > 0 || (await deps.nothing.has(task))) {
        return undefined;
      }
      const projects: { project: string; environments: string[] }[] = [];
      for (const repo of task.repos) {
        if (repo.writes === false) continue;
        const envs = (await deps.projects.get(repo.project).catch(() => undefined))?.deploy ?? [];
        if (envs.length === 0) continue;
        projects.push({
          project: repo.project,
          environments: envs.map(
            (e) =>
              `${e.env} (${e.tier}${e.branch === undefined ? "" : `, deploys when ${e.branch} is pushed or merged: plan a gitlab-merge run into ${e.branch}`}${e.recipe === undefined ? "" : `, majhi read its deploy from ${e.recipe.from.file}: leave runs out of the step to use it`})`,
          ),
        });
      }
      return projects.length === 0 ? undefined : { task: id, title: task.title, projects };
    },
    async recheck(_org, step) {
      const task = deps.store.tasks.get(step.task);
      if (task === undefined) return `${step.task} is gone`;
      const found = (await planner.stepsOf(task)).find(
        (s) => s.project === step.project && s.env === step.env,
      );
      return found?.state === "captain-next" && found.commit === step.commit
        ? undefined
        : (found?.why ?? "it is not the captain's to deploy now");
    },
    async deploy(_org, step) {
      // The whole plan of the task goes, every target in order, the way a case's fix does. A plan that names its
      // own runs (no recipe) goes a record at a time.
      const whole = await deps.runTask?.(step.task);
      if (whole !== undefined) return whole;
      const plan = await deps.ship.plan(step.task).catch(() => undefined);
      return service.deploy({ record: step.record }, "captain", plan?.rest);
    },
  };

  const view = async (id: string): Promise<ProjectDeployView> => {
    const info = await deps.projects.get(id);
    return {
      project: info.id,
      environments: info.deploy,
      history: service.history(info.id),
      rollingBack: service.rollingBackIds(),
    };
  };

  // The board reads this every few seconds: the answer is kept for a moment and dropped when a deploy changes.
  let board: { at: number; value: HomeDeploy[] } | undefined;
  service.onChange(() => {
    board = undefined;
  });
  const boardNow = async (): Promise<HomeDeploy[]> => {
    if (board !== undefined && now().getTime() - board.at < BOARD_KEEP_MS) return board.value;
    const since = new Date(now().getTime() - DEPLOY_WINDOW_MS).toISOString();
    const value: HomeDeploy[] = [];
    for (const id of deps.store.tasks.landedSince(since).slice(0, BOARD_TASKS)) {
      const task = deps.store.tasks.get(id);
      if (task === undefined) continue;
      const steps = await planner.stepsOf(task).catch(() => []);
      if (steps.length === 0 || deployPhase(steps) === "done") continue;
      value.push({ task: id, steps: steps.map(({ task: _task, sync: _sync, ...step }) => step) });
    }
    board = { at: now().getTime(), value };
    return value;
  };

  const discovery = new DeployDiscovery({
    projects: deps.projects,
    git: deployGit,
    repoRef: (p, remote) => repoRef(projectOf(p), remote),
    remoteOf: (p) => mrRemoteName(p.remotes),
    remotes: async (p) =>
      (await git(p.path, ["remote"]).catch(() => ""))
        .split("\n")
        .map((n) => n.trim())
        .filter((n) => n !== ""),
    lastDeploy: (p, env) => service.lastDeployAt(projectOf(p), env),
    said: (org, text) => deps.said?.(org, text),
  });

  return { service, planner, discovery, ports, view, board: boardNow, changed };
}
