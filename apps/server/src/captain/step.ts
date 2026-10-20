import { type CommandName, PRIVATE } from "@majhi/shared";
import type { AgentStore } from "../agents/store.ts";
import { mentionsName } from "../chat/rails.ts";
import type { ConfigService } from "../config/service.ts";
import type { Store } from "../store/index.ts";
import { inputWorkspaces, scopeWorldOf } from "./lane-scope.ts";

/**
 * Commands that put the caller's words into a workspace: a step's ask, a task's brief or note, a memory. They
 * are the doors by which one workspace's content could reach another's agents (docs/briefs/captain.md).
 */
const TEXT_INTO_WORKSPACE: ReadonlySet<CommandName> = new Set<CommandName>([
  "captain.step",
  "tasks.create",
  "tasks.tell",
  "tasks.update",
  "memory.add",
]);

/** Every string an input holds, however deep. */
function wordsOf(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (depth >= 4 || typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap((v) => wordsOf(v, depth + 1));
}

export interface StepGuardDeps {
  config: Pick<ConfigService, "sections">;
  agents: Pick<AgentStore, "list">;
  store: Pick<Store, "tasks">;
}

/**
 * One call acts in one workspace, and its words come from that workspace. A step, a task brief, a note or a
 * memory for workspace B never carries workspace A's names or ids: the owner owns all of it and the captain may
 * read it all in the All conversation, but nothing is carried over in a call. Typed: the workspace comes from the
 * ids the input carries, and the foreign words are the other workspaces' ids, names, projects and tasks.
 */
export class StepGuard {
  constructor(private readonly deps: StepGuardDeps) {}

  /** Why the call may not go, or undefined. */
  async refusal(command: CommandName, input: Record<string, unknown>): Promise<string | undefined> {
    if (!TEXT_INTO_WORKSPACE.has(command)) return undefined;
    const sections = await this.deps.config.sections();
    const agents = new Map<string, string>();
    for (const a of await this.deps.agents.list()) {
      if (a.ok && a.agent.frontmatter.scope !== "root") agents.set(a.id, a.agent.frontmatter.scope);
    }
    const tasks = this.deps.store.tasks.list(false);
    const orgOfTask = new Map(tasks.map((t) => [t.id as string, t.org ?? null]));
    const world = scopeWorldOf(sections, agents, (id) => orgOfTask.get(id));
    const targets = [...new Set(inputWorkspaces(input, world))];
    const name = (org: string) => (org === PRIVATE ? "Private" : (sections.orgs[org]?.name ?? org));
    if (targets.length > 1) {
      return `Refused: this call reaches ${targets.map(name).join(" and ")}. A call acts in one workspace: make one call for each.`;
    }
    const target = targets[0] ?? PRIVATE;
    // Private is the owner's own: what they know of their clients may go there.
    if (target === PRIVATE) return undefined;
    const foreign: string[] = [];
    for (const [id, org] of Object.entries(sections.orgs)) {
      if (id === target || id === PRIVATE) continue;
      foreign.push(id, org.name);
    }
    for (const [id, project] of Object.entries(sections.projects)) {
      if (project.org !== target) foreign.push(id);
    }
    for (const t of tasks) if ((t.org ?? PRIVATE) !== target) foreign.push(t.id);
    const text = wordsOf(input);
    const stray = foreign.find((word) => text.some((t) => mentionsName(t, word)));
    if (stray === undefined) return undefined;
    return `Refused: this call acts in ${name(target)}, and its text names ${stray}, which belongs to another workspace. A step gets only its own workspace's facts: write it without ${stray}.`;
  }
}
