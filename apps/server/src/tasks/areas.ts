import { PRIVATE, type Task, type TaskAreas, type TaskRepo, type WikiRole } from "@majhi/shared";
import { git } from "../git/git.ts";
import { changedFiles } from "./planner.ts";

/** A wiki component of a project: the folder it covers and the role the wiki found for it. */
export interface ComponentRef {
  name: string;
  folder: string;
  role: WikiRole;
}

/** What the areas of a task are read from. */
export interface AreasSource {
  /** Whether the workspace has a wiki. Without one a task has no areas. */
  enabled(org: string): Promise<boolean>;
  /** The components the wiki knows for a project. */
  components(org: string, project: string): Promise<readonly ComponentRef[]>;
}

/** How long a task's areas are reused: a diff is a git read per repo, and the board asks for many tasks. */
const REUSE_MS = 30_000;
/** Tasks read at once when the board asks for many. */
const AT_ONCE = 4;

/** The component a repo-relative path falls in: the deepest folder that contains it. */
function componentOf(path: string, components: readonly ComponentRef[]): ComponentRef | undefined {
  let best: ComponentRef | undefined;
  for (const c of components) {
    const inside = path === c.folder || path.startsWith(`${c.folder}/`);
    if (inside && (best === undefined || c.folder.length > best.folder.length)) best = c;
  }
  return best;
}

/**
 * Maps the files each project changed to its components. Files outside every component count as
 * `unmapped`, but only in a project that has components to fall in.
 */
export function mapAreas(
  repos: readonly { project: string; files: readonly string[]; components: readonly ComponentRef[] }[],
): TaskAreas {
  const areas: TaskAreas["areas"] = [];
  let unmapped = 0;
  for (const repo of repos) {
    if (repo.components.length === 0) continue;
    const counts = new Map<ComponentRef, number>();
    for (const file of repo.files) {
      const c = componentOf(file, repo.components);
      if (c === undefined) unmapped += 1;
      else counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    for (const [c, files] of counts) {
      areas.push({ project: repo.project, component: c.name, folder: c.folder, role: c.role, files });
    }
  }
  return { areas, unmapped };
}

const NONE: TaskAreas = { areas: [], unmapped: 0 };

/** The files a repo's task changed: its worktree's diff against where it forked, or, once merged and cleaned up, its start commit to the merged head. */
async function changedIn(repo: TaskRepo): Promise<string[]> {
  if (repo.worktree !== undefined) return changedFiles(repo.worktree, repo.base);
  if (repo.startCommit === undefined || repo.shipped === undefined) return [];
  const out = await git(repo.source, ["diff", "--name-only", repo.startCommit, repo.shipped.head]).catch(
    () => "",
  );
  return out.split("\n").filter((l) => l.trim() !== "");
}

/** The parts of the system a task touches, derived on read from its diff and the wiki's components. */
export class AreasReader {
  private readonly kept = new Map<string, { at: number; areas: TaskAreas }>();

  constructor(
    private readonly source: AreasSource,
    private readonly now: () => number = Date.now,
  ) {}

  async of(task: Task): Promise<TaskAreas> {
    const org = task.org ?? PRIVATE;
    if (task.repos.length === 0 || !(await this.source.enabled(org))) return NONE;
    const kept = this.kept.get(task.id);
    if (kept !== undefined && this.now() - kept.at < REUSE_MS) return kept.areas;
    const repos = await Promise.all(
      task.repos.map(async (repo) => ({
        project: repo.project,
        files: await changedIn(repo).catch(() => []),
        components: await this.source.components(org, repo.project).catch(() => []),
      })),
    );
    const areas = mapAreas(repos);
    this.kept.set(task.id, { at: this.now(), areas });
    return areas;
  }

  /** Several tasks, a few at a time. */
  async many(tasks: readonly Task[]): Promise<{ task: string; areas: TaskAreas }[]> {
    const out: { task: string; areas: TaskAreas }[] = [];
    for (let i = 0; i < tasks.length; i += AT_ONCE) {
      const chunk = tasks.slice(i, i + AT_ONCE);
      out.push(...(await Promise.all(chunk.map(async (t) => ({ task: t.id, areas: await this.of(t) })))));
    }
    return out;
  }

  forget(task: string): void {
    this.kept.delete(task);
  }
}
