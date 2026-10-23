import type { CaseDeployPorts } from "../../cases/deploy.ts";
import { discoverEnvironments } from "../discover.ts";
import { ACME_SHOP_GITLAB_FILES, acmeShopCi, memoryCi } from "./acme-shop.ts";
import { C1, C2, push as pushTo, type Rig, rig } from "./rig.ts";

/**
 * The sample project on GitHub (where work merges) and GitLab (where production deploys through manual jobs), three
 * production targets, against the rig's fake hosts. Shared by the case deploy and a finished task's deploy.
 */

export const remotes = { origin: "github", gitlab: "gitlab" } as const;
export const slug = "acme/storefront";
/** The manual jobs of the sample project's GitLab pipeline. */
export const JOBS = [
  "image:build:production",
  "image:build:globex",
  "app:deploy:acme",
  "app:deploy:globex",
  "app:deploy:initech",
  "app:status:acme",
  "app:status:globex",
  "app:status:initech",
];

/** The sample project on GitHub (where fixes merge) and GitLab (where production deploys), both at the first commit. */
export async function gitlabWorld(real?: Parameters<typeof rig>[3]): Promise<Rig> {
  const found = await discoverEnvironments({
    files: await acmeShopCi(ACME_SHOP_GITLAB_FILES),
    base: "main",
    provider: "gitlab",
    remote: "gitlab",
    folders: ["backend", "frontend"],
    read: memoryCi(ACME_SHOP_GITLAB_FILES).read,
  });
  const r = await rig(
    found.environments.map((e) => ({ ...e, check: `https://${e.env}.acme.example/health` })),
    "github",
    remotes,
    real,
  );
  r.hosts.gitlabJobs = JOBS;
  r.sshHosts.push(
    { id: "globex-host", name: "Globex host", alias: "deploy@203.0.113.8" },
    { id: "initech-host", name: "Initech host", alias: "deploy@203.0.113.9" },
  );
  // What each target's containers run: acme and initech share the production registry, globex has its own.
  r.remoteRun.byAlias = {
    "deploy@203.0.113.7": "registry.acme.example/acme-shop/backend:1.4.7\npostgres:16",
    "deploy@203.0.113.8": "registry.globex.example/acme-shop/backend:globex-2.0.3",
    "deploy@203.0.113.9": "registry.acme.example/acme-shop/backend:1.4.7",
  };
  pushTo(r, C1);
  r.hosts.branches.set(`gitlab:${slug}:main`, C1);
  return r;
}

export const HOST = {
  acme: "deploy@203.0.113.7",
  globex: "deploy@203.0.113.8",
  initech: "deploy@203.0.113.9",
} as const;
export type Target = keyof typeof HOST;
export const reads = (r: Rig, env: string) => r.remote.filter((c) => c.alias === HOST[env as Target]).length;

/** The case deployer's ports over the rig: `paths` are the files the change touched, `landed` collects the lands. */
export function portsOf(r: Rig, paths: string[] | undefined, landed: string[] = []): CaseDeployPorts {
  return {
    environments: async () => r.project.environments,
    discover: async () => [],
    remember: async () => undefined,
    current: (project, env, opts) => r.service.current(project, env, opts),
    hostChoices: (project, env, connection) => r.service.hostChoices(project, env, connection),
    nextVersion: (project, env) => r.service.nextVersion(project, env),
    changedPaths: async () => paths,
    latestLive: (project, env) => r.store.deploys.latestLive(project, env),
    repeatable: (runs) => r.service.repeatable(runs),
    onHost: (project) => r.service.onHost(project),
    checks: async () => ({ ok: true }),
    land: async (_task, project) => {
      landed.push(project);
      pushTo(r, C2);
    },
    deploy: (input, actor, hint) => r.service.deploy(input, actor, undefined, hint),
    rollback: (id, actor) => r.service.rollback(id, actor),
    record: (id) => r.store.deploys.get(id),
    rollingBack: (id) => r.service.rollingBackIds().includes(id),
    now: () => new Date(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    pollMs: 1,
    waitMs: 60_000,
  };
}
