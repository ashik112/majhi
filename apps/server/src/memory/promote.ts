import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Actor, type Fact, parseScope, type Task } from "@majhi/shared";
import type { ConfigService } from "../config/service.ts";
import { UserError } from "../errors.ts";
import { git, gitOk } from "../git/git.ts";
import type { ProjectService } from "../projects/service.ts";
import type { TaskService } from "../tasks/service.ts";
import { addFact } from "./agentsMd.ts";
import type { MemoryService } from "./service.ts";

export interface PromotionDeps {
  memory: MemoryService;
  tasks: Pick<TaskService, "createChange">;
  projects: ProjectService;
  config: ConfigService;
}

/**
 * Promotion to AGENTS.md (SPEC 5.6): an active project fact becomes a bullet under `## Facts` in the
 * repo's `AGENTS.md`. majhi makes a task in that project with no agent, edits and commits in its
 * worktree, and leaves it in review; the owner merges it through the usual card.
 */
export class Promotion {
  constructor(private readonly deps: PromotionDeps) {}

  async promote(id: number, actor: Actor): Promise<{ fact: Fact; task: string }> {
    const { memory } = this.deps;
    const fact = memory.get(id);
    if (fact === undefined) throw new UserError(`Fact ${id} does not exist.`, 404);
    if (fact.status !== "active") {
      throw new UserError(`Fact ${id} is ${fact.status}. Only an active fact can go to AGENTS.md.`, 409);
    }
    const scope = parseScope(fact.scope);
    if (scope?.kind !== "project") {
      throw new UserError(
        `Fact ${id} is in ${fact.scope}. Only a project fact belongs in that repo's AGENTS.md.`,
        409,
      );
    }
    if (fact.promoted !== undefined) {
      throw new UserError(`Fact ${id} is already being added to AGENTS.md by ${fact.promoted}.`, 409);
    }
    const project = (await this.deps.projects.infos()).find((p) => p.id === scope.id);
    if (project === undefined || !project.exists) {
      throw new UserError(`Project "${scope.id}" is not registered, or its folder is not there.`, 409);
    }
    // Already in the base branch: nothing to add, and no task to make.
    const base = project.base;
    if (base !== undefined) {
      const there = await agentsOnBase(project.path, base);
      if (there !== "" && addFact(there, fact.text) === there) {
        throw new UserError(`AGENTS.md on ${base} already has this fact.`, 409);
      }
    }
    const task = await this.deps.tasks.createChange({
      text: `Add memory fact ${fact.id} to AGENTS.md in ${project.id}`,
      project: project.id,
      message: `docs: add a fact to AGENTS.md\n\n${fact.text}`,
      change: async (repo) => {
        const file = join(repo.worktree, "AGENTS.md");
        const old = await readFile(file, "utf8").catch(() => "");
        const next = addFact(old, fact.text);
        if (next === old) throw new UserError("AGENTS.md already has this fact.", 409);
        await writeFile(file, next);
      },
    });
    return { fact: memory.setPromoted(fact.id, task.id, actor), task: task.id };
  }

  /**
   * A promotion task was closed or removed. When its branch never reached the base branch the fact
   * did not get into AGENTS.md, so `promoted` is cleared, with a line in the log, and the owner can
   * promote it again. Call it before the branch is touched.
   */
  async release(task: Task): Promise<void> {
    const facts = this.deps.memory.promotedBy(task.id);
    if (facts.length === 0 || (await isMerged(task))) return;
    for (const fact of facts) {
      this.deps.memory.clearPromoted(
        fact.id,
        `${task.id} was closed without being merged, so the fact is not in AGENTS.md. It can be promoted again.`,
      );
    }
  }
}

/**
 * Whether the task's work is in its base branch, here or as the remote has it. A branch that is
 * gone, or a task without a repo, counts as not merged.
 */
async function isMerged(task: Task): Promise<boolean> {
  if (task.repos.length === 0) return false;
  for (const repo of task.repos) {
    let merged = false;
    for (const ref of [`origin/${repo.base}`, repo.base]) {
      if (await gitOk(repo.source, ["merge-base", "--is-ancestor", repo.branch, ref])) merged = true;
    }
    if (!merged) return false;
  }
  return true;
}

/**
 * `AGENTS.md` as the base branch has it, or empty when there is none. A new task starts from the
 * remote's copy of the base when the repo has one, so that is read first.
 */
async function agentsOnBase(repo: string, base: string): Promise<string> {
  for (const ref of [`origin/${base}`, base]) {
    if (await gitOk(repo, ["rev-parse", "--verify", "--quiet", ref])) {
      return git(repo, ["show", `${ref}:AGENTS.md`]).catch(() => "");
    }
  }
  return "";
}
