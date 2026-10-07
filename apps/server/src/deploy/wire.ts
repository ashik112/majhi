import { type DeployRecord, PRIVATE, type ProjectDeployView, textValue } from "@majhi/shared";
import { auditActor, auditDetail } from "../audit.ts";
import type { DeployNext, DeployPorts } from "../captain/ports.ts";
import type { ConfigSections } from "../config/sections.ts";
import type { ConfigService } from "../config/service.ts";
import { type RemoteRunFn, runRemote } from "../connections/remote.ts";
import type { Fetch } from "../gitConnect/http.ts";
import { remoteUrl } from "../mrs/push.ts";
import { mrHostOf, mrRemoteName, repoSlug } from "../mrs/remote.ts";
import { fsRepoFiles } from "../projectcard/files.ts";
import type { ProjectInfo, ProjectService } from "../projects/service.ts";
import type { ShipPlanner } from "../ship/plan.ts";
import type { Store } from "../store/index.ts";
import type { TaskService } from "../tasks/service.ts";
import { type CredentialDeps, createDeployCredentials } from "./credentials.ts";
import { deployGit } from "./git.ts";
import { createGitHubProvider } from "./github.ts";
import { createGitLabProvider } from "./gitlab.ts";
import { DeployPlanner } from "./plan.ts";
import { type DeployProject, DeployService } from "./service.ts";
import { createSshProvider } from "./ssh.ts";
import { suggestDeploys } from "./suggest.ts";
import type { ProviderDeps, Providers, RepoRef } from "./types.ts";
import { createVercelProvider } from "./vercel.ts";

/** Work merged this long ago is still deployed by the rules; older work is left alone. */
export const DEPLOY_WINDOW_MS = 3 * 86_400_000;

/** How long the deploy service looks at a run, and at the check, and how long a run may take. */
export interface DeployTiming {
  pollMs: number;
  verifyMs: number;
  runTimeoutMs: number;
}

export const DEFAULT_TIMING: DeployTiming = { pollMs: 5_000, verifyMs: 5_000, runTimeoutMs: 30 * 60_000 };

export interface DeployWorldDeps {
  store: Store;
  config: ConfigService;
  projects: ProjectService;
  tasks: Pick<TaskService, "create" | "get">;
  ship: Pick<ShipPlanner, "plan">;
  credentials: CredentialDeps;
  /** The watch engine, once it exists: one look at a watch of the workspace, and the ones that look at an address. */
  watch: (org: string, id: string) => Promise<{ ok: boolean; detail: string }>;
  watches: (org: string) => Promise<{ id: string; name: string; url?: string | undefined }[]>;
  checksConfigured: (project: string) => boolean;
  tellOwner: (key: string, text: string) => void;
  /** A deploy went live: the captain's ship chore of the workspace looks again. */
  onLive: (org: string) => void;
  changed: () => void;
  fetch?: Fetch | undefined;
  remote?: RemoteRunFn | undefined;
  vercelApi?: string | undefined;
  timing?: Partial<DeployTiming> | undefined;
  now?: (() => Date) | undefined;
}

export interface DeployWorld {
  service: DeployService;
  planner: DeployPlanner;
  /** What the captain's ship chore reads and does. */
  ports: DeployPorts;
  /** The project's page: targets, what majhi found, history. */
  view(project: string): Promise<ProjectDeployView>;
}

const HEALTH_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function projectOf(p: ProjectInfo): DeployProject {
  return { id: p.id, org: p.org, path: p.path, base: p.base, remotes: p.remotes, targets: p.deploy };
}

function connectionViews(sections: ConfigSections, org: string) {
  return Object.entries(sections.orgs[org]?.connections ?? {}).map(([id, c]) => ({
    id,
    type: c.type,
    provider: textValue(c, "provider"),
    vercel: c.vars?.VERCEL_TOKEN !== undefined,
  }));
}

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
  const providers: Providers = {
    "github-workflow": createGitHubProvider(providerDeps),
    "gitlab-pipeline": createGitLabProvider(providerDeps),
    vercel: createVercelProvider(providerDeps),
    ssh: createSshProvider(providerDeps),
  };

  const project = async (id: string): Promise<DeployProject> => projectOf(await deps.projects.get(id));

  const repoRef = async (p: DeployProject): Promise<RepoRef | undefined> => {
    const remote = mrRemoteName(p.remotes);
    const url = await remoteUrl(p.path, remote).catch(() => undefined);
    if (url === undefined) return undefined;
    const provider = mrHostOf(p.remotes[remote], url);
    return provider === undefined ? undefined : { provider, slug: repoSlug(url) };
  };

  /** Opens the incident task of a failed deploy: typed `incident`, its origin the deploy, in the deploy's workspace. */
  const openIncident = async (input: {
    org: string;
    project: string;
    record: DeployRecord;
    title: string;
    text: string;
  }): Promise<string | undefined> => {
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

  const service: DeployService = new DeployService({
    repo: deps.store.deploys,
    projects: { get: project },
    tasks: {
      get: (id) => {
        const t = deps.store.tasks.get(id);
        return t === undefined ? undefined : { id: t.id, org: t.org };
      },
      landedCommits: (id) => new Set(deps.store.tasks.landings(id, 200).map((l) => l.commit)),
    },
    git: deployGit,
    repoRef,
    checksConfigured: deps.checksConfigured,
    providers,
    providerDeps,
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
      watch: (org, id) => deps.watch(org, id),
    },
    openIncident,
    tellOwner: (_org, key, text) => deps.tellOwner(key, text),
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
    now,
    sleep,
    ...timing,
  });

  const planner = new DeployPlanner({
    service,
    repo: deps.store.deploys,
    ship: (id) => deps.ship.plan(id),
    targets: async (id) => (await deps.projects.get(id).catch(() => undefined))?.deploy ?? [],
  });

  const next = async (org: string): Promise<DeployNext[]> => {
    const since = new Date(now().getTime() - DEPLOY_WINDOW_MS).toISOString();
    const out = new Map<string, DeployNext>();
    for (const id of deps.store.tasks.landedSince(since)) {
      const task = deps.store.tasks.get(id);
      if (task === undefined || (task.org ?? PRIVATE) !== org) continue;
      const [steps, plan] = await Promise.all([
        planner.stepsOf(task).catch(() => []),
        deps.ship.plan(id).catch(() => undefined),
      ]);
      for (const s of steps) {
        if ((s.state !== "captain-next" && s.state !== "waits-for-owner") || s.commit === undefined) continue;
        const key = `${s.project}:${s.env}:${s.commit}`;
        if (out.has(key)) continue;
        out.set(key, {
          task: id,
          title: task.title,
          project: s.project,
          env: s.env,
          commit: s.commit,
          who: s.who,
          ...(plan?.ruleSubject === undefined ? {} : { rule: plan.ruleSubject }),
        });
      }
    }
    return [...out.values()];
  };

  const ports: DeployPorts = {
    next,
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
      const plan = await deps.ship.plan(step.task).catch(() => undefined);
      return service.deploy(
        { project: step.project, env: step.env, task: step.task, commit: step.commit },
        "captain",
        plan?.rest,
      );
    },
  };

  const view = async (id: string): Promise<ProjectDeployView> => {
    const info = await deps.projects.get(id);
    const sections = await deps.config.sections();
    const ref = await repoRef(projectOf(info));
    const suggestions = await suggestDeploys(
      { id: info.id, org: info.org, path: info.path, provider: ref?.provider },
      info.deployHidden,
      {
        files: fsRepoFiles,
        connections: async (org) => connectionViews(sections, org),
        watches: deps.watches,
      },
      info.deploy,
    ).catch(() => []);
    return {
      project: info.id,
      targets: info.deploy,
      suggestions,
      history: service.history(info.id),
    };
  };

  return { service, planner, ports, view };
}
