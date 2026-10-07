import type { DeployEnvironment, DeployRecord, DeployRunStep } from "@majhi/shared";
import type { RemoteRunFn } from "../../connections/remote.ts";
import { Store } from "../../store/index.ts";
import { createBitbucketProvider } from "../bitbucket.ts";
import { createGitHubProvider } from "../github.ts";
import { createGitLabProvider } from "../gitlab.ts";
import { type DeployProject, DeployService } from "../service.ts";
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
  remoteRun: { code: number | null; output: string };
}

export async function rig(
  environments: DeployEnvironment[],
  provider: "github" | "gitlab" = "github",
): Promise<Rig> {
  const hosts = await startFakeHosts();
  const store = new Store(":memory:");
  const tip = { value: C1 };
  const landed = new Set([C1, C2, C3]);
  const health = { status: 200, queue: [] as number[] };
  const tell: string[] = [];
  const incidents: Rig["incidents"] = [];
  const remote: Rig["remote"] = [];
  const remoteRun = { code: 0 as number | null, output: "" };
  const project: DeployProject = {
    id: "storefront",
    org: "acme",
    path: "/work/storefront",
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
    ssh: async (org, connection) =>
      org === "acme" && connection === "acme-host"
        ? { alias: "deploy@203.0.113.7" }
        : { problem: `${org} has no connection ${connection}` },
  };
  const run: RemoteRunFn = async (alias, command) => {
    remote.push({ alias, command });
    return remoteRun;
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
    git: { tip: async () => tip.value },
    repoRef: async () => ({ provider, slug: "acme/storefront", host: hosts.host }),
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
  };
}

/** Points the fake GitHub's main at the commit, as a push does. */
export function push(r: Rig, sha: string) {
  r.hosts.branches.set("github:acme/storefront:main", sha);
  r.tip.value = sha;
}
