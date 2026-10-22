import type { CommandMeta, DeployEnvironment } from "@majhi/shared";
import { readCiFiles } from "../ci/read.ts";
import type { ProjectInfo } from "../projects/service.ts";
import { type DiscoverInput, discoverEnvironments } from "./discover.ts";
import type { DeployGit } from "./git.ts";
import type { RepoRef } from "./types.ts";

/**
 * Registers the environments a project's CI deploys (docs/briefs/deploy-from-ci.md). It reads the CI files at the tip
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

export class DeployDiscovery {
  private readonly running = new Map<string, Promise<DiscoveryResult>>();

  constructor(private readonly deps: DiscoveryDeps) {}

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
    const repo = await this.deps.repoRef(project);
    if (repo === undefined)
      return { ...none, skipped: `${projectId} has no remote on a host majhi deploys through` };
    const tip = await this.deps.git.tip(project.path, project.base);
    if (tip === undefined) return { ...none, skipped: `${projectId} has no single head on ${project.base}` };
    const files = await readCiFiles({
      read: (rel) => this.deps.git.file(project.path, tip, rel),
      list: (rel) => this.deps.git.list(project.path, tip, rel),
    });
    const input: DiscoverInput = {
      files,
      base: project.base,
      provider: repo.provider,
      remote: this.deps.remoteOf(project),
      folders: await foldersOf(this.deps.git, project.path, tip),
    };
    const found = discoverEnvironments(input);

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
      } else if (JSON.stringify(have.recipe) !== JSON.stringify(env.recipe)) {
        // The recipe is read from the CI, so it follows the CI. What the owner set on the environment stays.
        next[at] = { ...have, ...(env.recipe === undefined ? {} : { recipe: env.recipe }) };
        updated.push(env.env);
      }
    }
    if (added.length === 0 && updated.length === 0) return { ...none, dismissed };

    await this.deps.projects.setEnvironments(project.id, next, "projects.setEnvironments", META);
    const where = found.environments
      .filter((e) => added.includes(e.env) || updated.includes(e.env))
      .map(
        (e) =>
          `${e.env} (${e.recipe?.from.file}${e.recipe?.from.line === undefined ? "" : `:${e.recipe.from.line}`})`,
      )
      .join(", ");
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
