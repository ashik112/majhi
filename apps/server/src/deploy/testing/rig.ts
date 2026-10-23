import type { DeployEnvironment, DeployRecord, DeployRunStep } from "@majhi/shared";
import type { RemoteRunFn } from "../../connections/remote.ts";
import { Store } from "../../store/index.ts";
import { createBitbucketProvider } from "../bitbucket.ts";
import { createGitHubProvider } from "../github.ts";
import { createGitLabProvider } from "../gitlab.ts";
import type { DeployGit } from "../git.ts";
import { type DeployDeps, type DeployProject, DeployService } from "../service.ts";
import { createSshProvider } from "../ssh.ts";
import type { DeployCredentials, ProviderDeps, Providers } from "../types.ts";
import { createVercelProvider } from "../vercel.ts";
import { type FakeHosts, startFakeHosts } from "./fake-hosts.ts";

/** A deploy service on an in-memory store, a fake GitHub, GitLab and Vercel, and a fake ssh host. */

export const C1 = "1111111111111111111111111111111111111111";
export const C2 = "2222222222222222222222222222222222222222";
export const C3 = "3333333333333333333333333333333333333333";

/** An environment that answers its check address. `staging` is the staging tier, anything else production. */
export const environment = (env: string, over: Partial<DeployEnvironment> = {}): DeployEnvironment => ({
  env,
  tier: env === "staging" ? "staging" : "production",
  check: `https://${env}.acme.example/health`,
  ...over,
});

/** One GitHub workflow run on the project's origin, and the same for GitLab. */
export const GH: DeployRunStep[] = [
  { kind: "github-workflow", remote: "origin", workflow: "deploy.yml", ref: "base" },
];
export const GL_PIPELINE: DeployRunStep[] = [{ kind: "gitlab-pipeline", remote: "origin", ref: "base" }];

export interface Rig {
  store: Store;
  hosts: FakeHosts;
  service: DeployService;
  tell: string[];
  incidents: { title: string; text: string; record: DeployRecord }[];
  remote: { alias: string; command: string }[];
  /** What the base branch is at, per project. */
  tip: { value: string };
  landed: Set<string>;
  health: { status: number; queue: number[] };
  project: DeployProject;
  tasks: Map<string, { id: string; org: string | undefined }>;
  checks: { configured: boolean };
  /** False: the workspace is not signed in to the host. */
  signedIn: { value: boolean };
  /** What a command on a host answers: `output` for any host, or the host's own in `byAlias`. */
  remoteRun: { code: number | null; output: string; byAlias: Record<string, string> };
  /** The workspace's ssh connections. */
  sshHosts: { id: string; name: string; alias: string }[];
  /** What was pushed to a remote that deploys, in order: the remote and the commit. */
  published: { remote: string; commit: string; actor: string }[];
  /** A sentence: the push is refused with it. Absent: the push works, and GitLab makes the commit's pipeline. */
  refusePush: { why: string | undefined };
}

export async function rig(
  environments: DeployEnvironment[],
  provider: "github" | "gitlab" = "github",
  /** The host each remote of the project is on, when it has several (`origin` on GitHub, `gitlab` on GitLab). */
  remotes: Readonly<Record<string, "github" | "gitlab">> = {},
  /** A project with real repositories on disk (the deploy reads them as it does in majhi) instead of the stub. */
  real?: {
    path: string;
    git: DeployGit;
    refresh?: DeployDeps["refresh"];
    /** The push of the base branch to a remote that deploys: a real push, so a non-fast-forward is refused. */
    push?: (input: {
      remote: string;
      branch: string;
      commit: string;
    }) => Promise<{ ok: true } | { ok: false; why: string }>;
  },
): Promise<Rig> {
  const hosts = await startFakeHosts();
  const store = new Store(":memory:");
  const tip = { value: C1 };
  const landed = new Set([C1, C2, C3]);
  const health = { status: 200, queue: [] as number[] };
  const tell: string[] = [];
  const incidents: Rig["incidents"] = [];
  const remote: Rig["remote"] = [];
  const remoteRun = { code: 0 as number | null, output: "", byAlias: {} as Record<string, string> };
  const sshHosts: { id: string; name: string; alias: string }[] = [
    { id: "acme-host", name: "Acme host", alias: "deploy@203.0.113.7" },
  ];
  const published: Rig["published"] = [];
  const refusePush: Rig["refusePush"] = { why: undefined };
  const project: DeployProject = {
    id: "storefront",
    org: "acme",
    path: real?.path ?? "/work/storefront",
    base: "main",
    remotes: {},
    environments,
  };
  const credentials: DeployCredentials = {
    git: async (org, host, kind) =>
      org === "acme" && signedIn.value && host === hosts.host
        ? { token: kind === "github" ? hosts.tokens.github : hosts.tokens.gitlab }
        : { problem: `${org} is not signed in to ${host}` },
    variable: async (org, connection) =>
      org === "acme" && connection === "acme-vercel"
        ? { value: hosts.tokens.vercel }
        : { problem: `${org} has no connection ${connection}` },
    sshHosts: async (org) => (org === "acme" ? sshHosts : []),
    ssh: async (org, connection) => {
      const found = org === "acme" ? sshHosts.find((h) => h.id === connection) : undefined;
      return found === undefined
        ? { problem: `${org} has no connection ${connection}` }
        : { alias: found.alias };
    },
  };
  const run: RemoteRunFn = async (alias, command) => {
    remote.push({ alias, command });
    return { code: remoteRun.code, output: remoteRun.byAlias[alias] ?? remoteRun.output };
  };
  const providerDeps: ProviderDeps = {
    fetch,
    credentials,
    remote: run,
    sleep: async () => undefined,
    now: () => new Date(),
    vercelApi: hosts.url,
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
  const tasks: Rig["tasks"] = new Map([
    ["ACM-1", { id: "ACM-1", org: "acme" }],
    ["GLX-9", { id: "GLX-9", org: "globex" }],
  ]);
  const checks = { configured: true };
  const signedIn = { value: true };
  const service = new DeployService({
    repo: store.deploys,
    projects: { get: async () => ({ ...project }) },
    tasks: { get: (id) => tasks.get(id), landedCommits: () => landed },
    git: real?.git ?? {
      tip: async () => tip.value,
      heads: async () => ({ kind: "ready", commit: tip.value }),
      file: async () => undefined,
      list: async () => [],
    },
    ...(real?.refresh === undefined ? {} : { refresh: real.refresh }),
    repoRef: async (_project, remote) => ({
      provider: remotes[remote ?? "origin"] ?? provider,
      slug: "acme/storefront",
      host: hosts.host,
    }),
    // A push of the base branch to GitLab: it takes the commit on its default branch and starts the commit's pipeline.
    publish: async ({ remote, branch, commit, actor }) => {
      published.push({ remote, commit, actor });
      if (refusePush.why !== undefined) return { ok: false, why: refusePush.why };
      const pushed = await real?.push?.({ remote, branch, commit });
      if (pushed !== undefined && !pushed.ok) return pushed;
      hosts.branches.set(`gitlab:acme/storefront:${branch}`, commit);
      hosts.addPipeline("acme/storefront", commit);
      return { ok: true };
    },
    checksConfigured: () => checks.configured,
    providers,
    providerDeps,
    looks: {
      health: async () => ({ status: health.queue.shift() ?? health.status }),
    },
    checkSeconds: 0,
    openIncident: async (input) => {
      incidents.push({ title: input.title, text: input.text, record: input.record });
      return "ACM-77";
    },
    tellOwner: (_org, _key, text) => tell.push(text),
    audit: () => undefined,
    changed: () => undefined,
    now: () => new Date(),
    sleep: async () => undefined,
    pollMs: 1,
    verifyMs: 1,
    runTimeoutMs: 60_000,
  });
  return {
    store,
    hosts,
    service,
    tell,
    incidents,
    remote,
    tip,
    landed,
    health,
    project,
    tasks,
    checks,
    signedIn,
    remoteRun,
    sshHosts,
    published,
    refusePush,
  };
}

/** Points the fake GitHub's main at the commit, as a push does. */
export function push(r: Rig, sha: string) {
  r.hosts.branches.set("github:acme/storefront:main", sha);
  r.tip.value = sha;
}
