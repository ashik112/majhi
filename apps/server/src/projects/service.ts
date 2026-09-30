import { isAbsolute, relative } from "node:path";
import type { CommandMeta, ProjectConfig, ProjectLink, ProjectView, RemoteConfig } from "@majhi/shared";
import { resolvePath } from "../config/load.ts";
import type { ConfigService } from "../config/service.ts";
import { removeProjectEntry, writeProject } from "../config/write.ts";
import { UserError } from "../errors.ts";
import { defaultBranch, isGitRepo } from "../git/git.ts";
import { MergeOrderCycle, type ProjectGraph, pathBetween } from "../mrs/order.ts";
import { mrRemoteName } from "../mrs/remote.ts";
import type { TaskRepo } from "../store/tasks.ts";

/** How long a repo's default branch is reused. */
export const BASE_CACHE_MS = 30_000;

export interface RegisterInput {
  id: string;
  org: string;
  path: string;
  aliases: string[];
  base?: string | undefined;
  remotes?: Record<string, RemoteConfig> | undefined;
  links?: ProjectLink[] | undefined;
}

export interface UpdateInput {
  id: string;
  org: string;
  aliases: string[];
  base?: string | undefined;
  /** Absent: keep. null: remove. */
  remotes?: Record<string, RemoteConfig> | null | undefined;
  links?: ProjectLink[] | null | undefined;
}

/** A registered project with everything a task needs from it. */
export interface ProjectInfo {
  id: string;
  org: string;
  /** Absolute path of the checkout. */
  path: string;
  aliases: string[];
  /** Project base, else the org's, else the repo's default branch. */
  base: string | undefined;
  exists: boolean;
  remotes: Record<string, RemoteConfig>;
  links: ProjectLink[];
}

/** Projects in majhi.yaml: registering, changing, and resolving each one's base branch. */
export class ProjectService {
  private readonly defaults = new Map<string, { at: number; branch: string | undefined }>();

  constructor(
    private readonly config: ConfigService,
    private readonly tasks: TaskRepo,
    private readonly now: () => number = Date.now,
  ) {}

  async list(): Promise<ProjectView[]> {
    return (await this.infos()).map(toView);
  }

  /** Every project, resolved. Empty until majhi.yaml loads. */
  async infos(): Promise<ProjectInfo[]> {
    const loaded = await this.config.load();
    if (loaded.state.status !== "loaded") return [];
    const sections = await this.config.sections();
    return Promise.all(
      Object.entries(sections.projects).map(async ([id, project]) => {
        const path = resolvePath(project.path, this.config.paths.hostHome);
        const exists = await isGitRepo(path);
        const base =
          project.base ??
          sections.orgs[project.org]?.base ??
          (exists ? await this.repoDefault(path) : undefined);
        const info: ProjectInfo = {
          id,
          org: project.org,
          path,
          aliases: project.aliases,
          base,
          exists,
          remotes: project.remotes ?? {},
          links: project.links ?? [],
        };
        return info;
      }),
    );
  }

  async get(id: string): Promise<ProjectInfo> {
    const found = (await this.infos()).find((p) => p.id === id);
    if (found === undefined) throw new UserError(`Project "${id}" does not exist.`, 404);
    return found;
  }

  async register(input: RegisterInput, command: string, meta: CommandMeta): Promise<ProjectView> {
    const loaded = await this.config.load();
    if (loaded.state.status !== "loaded") {
      throw new UserError("Pick workspace roots first: majhi.yaml is not ready.", 409);
    }
    const sections = await this.config.sections();
    if (sections.orgs[input.org] === undefined) {
      throw new UserError(`Org "${input.org}" does not exist. Create the org first.`);
    }
    if (sections.projects[input.id] !== undefined) {
      throw new UserError(`Project "${input.id}" already exists.`, 409);
    }
    const path = resolvePath(input.path, this.config.paths.hostHome);
    const roots = loaded.state.config.workspaces;
    if (!roots.some((root) => isInside(root, path))) {
      throw new UserError(`${path} is not inside a workspace root (${roots.join(", ")}).`);
    }
    if (!(await isGitRepo(path))) {
      throw new UserError(`${path} is not a git repo the server can see.`);
    }
    const same = Object.entries(sections.projects).find(
      ([, p]) => resolvePath(p.path, this.config.paths.hostHome) === path,
    );
    if (same !== undefined) throw new UserError(`${path} is already registered as "${same[0]}".`, 409);
    checkNames(input.id, input.aliases, sections.projects);
    if (input.remotes !== undefined) checkRemotes(input.remotes);
    if (input.links !== undefined) checkLinks(input.id, input.links, sections.projects);

    const project: ProjectConfig = { org: input.org, path: input.path, aliases: dedupe(input.aliases) };
    if (input.base !== undefined) project.base = input.base;
    if (input.remotes !== undefined && Object.keys(input.remotes).length > 0) project.remotes = input.remotes;
    if (input.links !== undefined && input.links.length > 0) project.links = dedupeLinks(input.links);
    await this.config.change(
      { command, meta, summary: `registered project ${input.id} (${input.org})` },
      () => writeProject(this.config.file, input.id, project),
    );
    return toView(await this.get(input.id));
  }

  async update(input: UpdateInput, command: string, meta: CommandMeta): Promise<ProjectView> {
    const sections = await this.config.sections();
    const current = sections.projects[input.id];
    if (current === undefined) throw new UserError(`Project "${input.id}" does not exist.`, 404);
    if (sections.orgs[input.org] === undefined) {
      throw new UserError(`Org "${input.org}" does not exist. Create the org first.`);
    }
    checkNames(input.id, input.aliases, sections.projects);
    const project: ProjectConfig = { ...current, org: input.org, aliases: dedupe(input.aliases) };
    if (input.base === undefined) delete project.base;
    else project.base = input.base;
    if (input.remotes !== undefined) {
      if (input.remotes === null || Object.keys(input.remotes).length === 0) delete project.remotes;
      else {
        checkRemotes(input.remotes);
        project.remotes = input.remotes;
      }
    }
    if (input.links !== undefined) {
      if (input.links === null || input.links.length === 0) delete project.links;
      else {
        checkLinks(input.id, input.links, sections.projects);
        project.links = dedupeLinks(input.links);
      }
    }
    await this.config.change({ command, meta, summary: `updated project ${input.id}` }, () =>
      writeProject(this.config.file, input.id, project),
    );
    return toView(await this.get(input.id));
  }

  async remove(id: string, command: string, meta: CommandMeta): Promise<void> {
    const sections = await this.config.sections();
    if (sections.projects[id] === undefined) throw new UserError(`Project "${id}" does not exist.`, 404);
    const open = this.tasks.openTasksUsing(id);
    if (open.length > 0) {
      throw new UserError(`Open tasks still use "${id}". Close or remove them first.`, 409, open);
    }
    await this.config.change({ command, meta, summary: `removed project ${id}` }, () =>
      removeProjectEntry(this.config.file, id),
    );
  }

  private async repoDefault(path: string): Promise<string | undefined> {
    const hit = this.defaults.get(path);
    if (hit !== undefined && this.now() - hit.at < BASE_CACHE_MS) return hit.branch;
    const branch = await defaultBranch(path);
    this.defaults.set(path, { at: this.now(), branch });
    return branch;
  }
}

function toView(p: ProjectInfo): ProjectView {
  const view: ProjectView = {
    id: p.id,
    org: p.org,
    path: p.path,
    aliases: p.aliases,
    exists: p.exists,
    remotes: p.remotes,
    links: p.links,
  };
  if (p.base !== undefined) view.base = p.base;
  if (Object.keys(p.remotes).length > 0) view.mrRemote = mrRemoteName(p.remotes);
  return view;
}

function dedupeLinks(links: readonly ProjectLink[]): ProjectLink[] {
  return [...new Map(links.map((l) => [l.to, l])).values()];
}

/** At most one remote takes MRs. */
function checkRemotes(remotes: Readonly<Record<string, RemoteConfig>>): void {
  const marked = Object.entries(remotes).filter(([, r]) => r.mr === true);
  if (marked.length > 1) {
    throw new UserError(
      `Only one remote can take MRs, but ${marked.map(([n]) => n).join(" and ")} are marked.`,
    );
  }
}

/** Links point at other registered projects and never close a loop (5.5). */
function checkLinks(
  id: string,
  links: readonly ProjectLink[],
  projects: Record<string, ProjectConfig>,
): void {
  for (const link of links) {
    if (link.to === id) throw new UserError(`Project "${id}" cannot depend on itself.`);
    if (projects[link.to] === undefined) throw new UserError(`Project "${link.to}" does not exist.`);
  }
  const graph: ProjectGraph = new Map([
    ...Object.entries(projects).map(([p, c]) => [p, (c.links ?? []).map((l) => l.to)] as const),
    [id, links.map((l) => l.to)],
  ]);
  const loop = pathBetween(graph, id, id);
  if (loop !== undefined) throw new UserError(new MergeOrderCycle(loop).message, 409);
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/** Aliases must be unique across projects and never another project's id; an id never another's alias. */
function checkNames(id: string, aliases: readonly string[], projects: Record<string, ProjectConfig>): void {
  for (const [otherId, other] of Object.entries(projects)) {
    if (otherId === id) continue;
    if (aliases.includes(otherId)) {
      throw new UserError(`Alias "${otherId}" is the id of another project.`, 409);
    }
    if (other.aliases.includes(id)) {
      throw new UserError(`"${id}" is already an alias of project "${otherId}".`, 409);
    }
    const clash = aliases.find((a) => other.aliases.includes(a));
    if (clash !== undefined) {
      throw new UserError(`Alias "${clash}" is already used by project "${otherId}".`, 409);
    }
  }
}
