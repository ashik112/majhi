import { isAbsolute, relative } from "node:path";
import type { CommandMeta, ProjectConfig, ProjectView } from "@majhi/shared";
import { resolvePath } from "../config/load.ts";
import type { ConfigService } from "../config/service.ts";
import { removeProjectEntry, writeProject } from "../config/write.ts";
import { UserError } from "../errors.ts";
import { defaultBranch, isGitRepo } from "../git/git.ts";
import type { TaskRepo } from "../store/tasks.ts";

/** How long a repo's default branch is reused. */
export const BASE_CACHE_MS = 30_000;

export interface RegisterInput {
  id: string;
  org: string;
  path: string;
  aliases: string[];
  base?: string | undefined;
}

export interface UpdateInput {
  id: string;
  org: string;
  aliases: string[];
  base?: string | undefined;
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
        const info: ProjectInfo = { id, org: project.org, path, aliases: project.aliases, base, exists };
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

    const project: ProjectConfig = { org: input.org, path: input.path, aliases: dedupe(input.aliases) };
    if (input.base !== undefined) project.base = input.base;
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
  const view: ProjectView = { id: p.id, org: p.org, path: p.path, aliases: p.aliases, exists: p.exists };
  if (p.base !== undefined) view.base = p.base;
  return view;
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
