import type { CommandMeta, DeployEnvironment } from "@majhi/shared";
import { readCiFiles } from "../ci/read.ts";
import type { ProjectInfo } from "../projects/service.ts";
import { type Discovered, type DiscoverInput, discoverEnvironments } from "./discover.ts";
import type { DeployGit } from "./git.ts";
import type { RepoRef } from "./types.ts";

/**
 * Registers the environments a project's CI deploys (docs/DECISIONS.md, "deploy from CI"). It reads the CI files at the tip
 * of the project's base branch, not the working tree (the checkout may be on another branch), finds the deploy path
 * with `discoverEnvironments`, and saves what is new through the one writer of environments. An environment the owner
 * removed before is not saved again. What it saved is said once, with the file and line it was read from.
 */

export interface DiscoveryDeps {
  projects: {
    get(id: string): Promise<ProjectInfo>;
    setEnvironments(
      id: string,
      environments: readonly DeployEnvironment[],
      command: string,
      meta: CommandMeta,
    ): Promise<unknown>;
  };
  git: Pick<DeployGit, "tip" | "file" | "list">;
  repoRef(project: ProjectInfo, remote?: string): Promise<RepoRef | undefined>;
  /** The remote the runs name: the one merge requests go to. */
  remoteOf(project: ProjectInfo): string;
  /** The names of the project's git remotes. */
  remotes(project: ProjectInfo): Promise<string[]>;
  /** When the host that deploys an environment last deployed it successfully (an ISO time), read from that host. */
  lastDeploy(project: ProjectInfo, env: DeployEnvironment): Promise<string | undefined>;
  /** One line for the workspace's log: what was found and where. */
  said(org: string, text: string): void;
}

export interface DiscoveryResult {
  added: string[];
  updated: string[];
  /** Environments the CI has that the owner removed before. */
  dismissed: string[];
  /** Why nothing was read, when it was not. */
  skipped?: string;
}

const META: CommandMeta = {
  actor: { kind: "owner" },
  reason: "majhi read how the project deploys from its CI files",
};

/** Folders where a part of the project may live: the root's, and the children of `apps`, `services` and `packages`. */
async function foldersOf(git: DiscoveryDeps["git"], path: string, tip: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await git.list(path, tip, "")) {
    if (!entry.dir) continue;
    out.push(entry.name);
    if (entry.name === "apps" || entry.name === "services" || entry.name === "packages") {
      for (const child of await git.list(path, tip, entry.name)) {
        if (child.dir) out.push(`${entry.name}/${child.name}`);
      }
    }
  }
  return out;
}

/** Whether two recipes say the same: the answers the owner gave are not part of what the CI says. */
function sameRecipe(a: DeployEnvironment["recipe"], b: DeployEnvironment["recipe"]): boolean {
  const bare = (r: DeployEnvironment["recipe"]) =>
    JSON.stringify(r === undefined ? r : { ...r, answers: {} });
  return bare(a) === bare(b);
}

/**
 * An environment that two remotes both describe (a GitHub workflow and a GitLab job for the same target) is deployed by
 * one of them. The owner's answer, kept on the environment, decides first; else the remote whose host has the most
 * recent successful deploy of it; a host with no deploy of it loses to one that has. With no history on either side the
 * environment keeps the first remote's recipe and asks once which one deploys it.
 */
const DEPLOY_VIA = "deploy-via";

export class DeployDiscovery {
  private readonly running = new Map<string, Promise<DiscoveryResult>>();
  /** The commit of the base branch each project's CI was last read at. */
  private readonly readAt = new Map<string, string>();

  constructor(private readonly deps: DiscoveryDeps) {}

  private async whichDeploys(
    project: ProjectInfo,
    name: string,
    candidates: readonly { remote: string; env: DeployEnvironment }[],
  ): Promise<DeployEnvironment> {
    const [first] = candidates;
    if (first === undefined) throw new Error("An environment has no remote");
    if (candidates.length === 1) return first.env;
    const kept = project.deploy.find((e) => e.env === name)?.recipe?.answers[DEPLOY_VIA];
    // A file says which one: the workflow or the pipeline file the recipe was read from.
    const fileOf = (c: { env: DeployEnvironment }) => c.env.recipe?.from.file;
    const chosen = candidates.find((c) => fileOf(c) === kept);
    if (chosen !== undefined) return chosen.env;
    const dated: { env: DeployEnvironment; at: number }[] = [];
    for (const c of candidates) {
      const when = await this.deps.lastDeploy(project, c.env).catch(() => undefined);
      const at = when === undefined ? Number.NaN : Date.parse(when);
      if (!Number.isNaN(at)) dated.push({ env: c.env, at });
    }
    const newest = dated.reduce<{ env: DeployEnvironment; at: number } | undefined>(
      (best, d) => (best === undefined || d.at > best.at ? d : best),
      undefined,
    );
    if (newest !== undefined) return newest.env;
    const files = candidates.flatMap((c) => fileOf(c) ?? []);
    const recipe = first.env.recipe;
    if (recipe === undefined) return first.env;
    return {
      ...first.env,
      recipe: {
        ...recipe,
        asks: [
          ...recipe.asks,
          {
            key: DEPLOY_VIA,
            question: `${name} is described by ${files.join(" and ")}, and none has deployed it yet. Which one deploys it?`,
            options: files.slice(0, 8),
          },
        ],
      },
    };
  }

  /**
   * Reads the CI again only when the project's base branch is at a commit it was not read at: the environments are
   * known without a scan or a case, and cost one git read while nothing moved. Undefined when nothing was read.
   */
  async refresh(projectId: string): Promise<DiscoveryResult | undefined> {
    const project = await this.deps.projects.get(projectId);
    if (!project.exists || project.base === undefined) return undefined;
    const tip = await this.deps.git.tip(project.path, project.base);
    if (tip === undefined || this.readAt.get(projectId) === tip) return undefined;
    return this.run(projectId);
  }

  /** Reads the CI of the project and saves its new environments. One read per project at a time. */
  run(projectId: string): Promise<DiscoveryResult> {
    const going = this.running.get(projectId);
    if (going !== undefined) return going;
    const job = this.read(projectId).finally(() => this.running.delete(projectId));
    this.running.set(projectId, job);
    return job;
  }

  private async read(projectId: string): Promise<DiscoveryResult> {
    const none: DiscoveryResult = { added: [], updated: [], dismissed: [] };
    const project = await this.deps.projects.get(projectId);
    if (!project.exists || project.base === undefined) {
      return { ...none, skipped: `${projectId} has no checkout or base branch to read` };
    }
    // Every remote on a host majhi deploys through: a project can build on one host and deploy on another (its GitHub
    // `origin` and a `gitlab` remote whose pipeline holds the production jobs). The merge request remote reads first.
    const mr = this.deps.remoteOf(project);
    const names = [mr, ...(await this.deps.remotes(project)).filter((n) => n !== mr)];
    const hosts: { remote: string; provider: RepoRef["provider"] }[] = [];
    for (const remote of names) {
      const repo = await this.deps.repoRef(project, remote);
      if (repo !== undefined) hosts.push({ remote, provider: repo.provider });
    }
    if (hosts.length === 0)
      return { ...none, skipped: `${projectId} has no remote on a host majhi deploys through` };
    const tip = await this.deps.git.tip(project.path, project.base);
    if (tip === undefined) return { ...none, skipped: `${projectId} has no single head on ${project.base}` };
    const files = await readCiFiles({
      read: (rel) => this.deps.git.file(project.path, tip, rel),
      list: (rel) => this.deps.git.list(project.path, tip, rel),
    });
    this.readAt.set(projectId, tip);
    const folders = await foldersOf(this.deps.git, project.path, tip);
    const found: Discovered = { environments: [], notes: [] };
    // What each remote says about each environment, in the order the environments first appear.
    const said = new Map<string, { remote: string; env: DeployEnvironment }[]>();
    for (const host of hosts) {
      const input: DiscoverInput = {
        files,
        base: project.base,
        provider: host.provider,
        remote: host.remote,
        folders,
        read: (rel) => this.deps.git.file(project.path, tip, rel),
      };
      const one = await discoverEnvironments(input);
      for (const env of one.environments)
        said.set(env.env, [...(said.get(env.env) ?? []), { remote: host.remote, env }]);
      found.notes.push(...one.notes);
    }
    // An environment is listed once. When several remotes describe it, the one that deploys it wins.
    for (const [name, candidates] of said) {
      found.environments.push(await this.whichDeploys(project, name, candidates));
    }

    const next = [...project.deploy];
    const added: string[] = [];
    const updated: string[] = [];
    const dismissed: string[] = [];
    for (const env of found.environments) {
      if (project.deployDismissed.includes(env.env)) {
        dismissed.push(env.env);
        continue;
      }
      const at = next.findIndex((e) => e.env === env.env);
      const have = next[at];
      if (have === undefined) {
        next.push(env);
        added.push(env.env);
      } else if (env.recipe === undefined && have.recipe !== undefined) {
        // The CI deploys it in a way majhi cannot play by itself (an earlier read saw something else): the recipe goes,
        // the environment stays.
        const { recipe: _gone, ...rest } = have;
        next[at] = rest;
        updated.push(env.env);
      } else if (env.recipe !== undefined && !sameRecipe(have.recipe, env.recipe)) {
        // The recipe is read from the CI, so it follows the CI. What the owner set on the environment stays, and so
        // do the answers the owner gave to its questions.
        next[at] = { ...have, recipe: { ...env.recipe, answers: have.recipe?.answers ?? {} } };
        updated.push(env.env);
      }
    }
    if (added.length === 0 && updated.length === 0) return { ...none, dismissed };

    await this.deps.projects.setEnvironments(project.id, next, "projects.setEnvironments", META);
    // Grouped by the file and line they were read from: "acme, globex from .github/workflows/release.yml:6".
    const bySource = new Map<string, string[]>();
    for (const e of found.environments) {
      if (!added.includes(e.env) && !updated.includes(e.env)) continue;
      const from = e.recipe?.from;
      const at =
        from === undefined ? "the CI" : `${from.file}${from.line === undefined ? "" : `:${from.line}`}`;
      bySource.set(at, [...(bySource.get(at) ?? []), e.env]);
    }
    const where = [...bySource].map(([at, names]) => `${names.join(", ")} from ${at}`).join("; ");
    const asking = found.environments.filter(
      (e) => (added.includes(e.env) || updated.includes(e.env)) && (e.recipe?.asks.length ?? 0) > 0,
    );
    this.deps.said(
      project.org,
      `Found how ${project.id} deploys from its CI: ${where}.${asking.length === 0 ? "" : ` ${asking.map((e) => e.env).join(", ")} will ask the owner once at its first deploy.`}`,
    );
    return { added, updated, dismissed };
  }
}
