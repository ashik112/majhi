import { z } from "zod";
import { UserError } from "../../errors.ts";
import { explain, loadGraph, neighbors, path, search } from "./query.ts";
import { graphFolder } from "./run.ts";

/** The agent tool over a project's code graph (`code_graph` in `majhi-room`). */
export const CodeGraphInputSchema = z.object({
  action: z.enum(["search", "explain", "neighbors", "path"]),
  /** What to look for: a function, class, file or words from a name. For `path`, where it starts. */
  name: z.string().trim().min(1).max(200),
  /** `path` only: where it ends. */
  to: z.string().trim().min(1).max(200).optional(),
  /** One of the task's repos. Absent: the task's first repo. */
  project: z.string().trim().min(1).max(120).optional(),
});
export type CodeGraphInput = z.infer<typeof CodeGraphInputSchema>;

export const CODE_GRAPH_DESCRIPTION =
  "Ask the code graph of one of this task's repos, instead of grepping or reading many files to find your way. It lists functions, classes and files with the calls and imports between them, built from the repo's default branch at the last map update (it may not show your own changes yet). search: find nodes by words of a name or path, best connected first. explain: what one node is, what it calls and what calls it. neighbors: the same links, shorter. path: the shortest chain of calls or imports from one node (name) to another (to). Start with search or explain to learn the structure, then read the files it points to. Only this task's own repos; read-only.";

export interface CodeGraphDeps {
  /** The map folder in the tasks folder. */
  root: () => Promise<string>;
  /** The workspace and repos of a task, or undefined for a task majhi does not know. */
  scope: (task: string) => { org: string; repos: readonly string[] } | undefined;
  /** The workspace a project belongs to. */
  orgOf: (project: string) => Promise<string | undefined>;
}

/**
 * Answers `code_graph` for a task. The workspace is the task's, never an argument, and the project must be
 * one of the task's own repos in that workspace: another workspace's graph, or a project the task does not
 * use, is refused before any file is opened.
 */
export class CodeGraphTools {
  constructor(private readonly deps: CodeGraphDeps) {}

  async call(task: string, input: CodeGraphInput): Promise<string> {
    const scope = this.deps.scope(task);
    if (scope === undefined) throw new UserError("This task is not known.");
    const project = input.project ?? scope.repos[0];
    if (project === undefined)
      throw new UserError("This task has no repos, so there is no code graph to ask.");
    if (!scope.repos.includes(project) || (await this.deps.orgOf(project)) !== scope.org) {
      throw new UserError(
        `"${project}" is not one of this task's repos. Ask about: ${scope.repos.join(", ") || "none"}.`,
      );
    }
    const folder = graphFolder(await this.deps.root(), scope.org, project);
    const graph = folder === null ? undefined : await loadGraph(folder);
    if (graph === undefined) {
      return `There is no code graph for ${project} yet. The owner builds it with Update map on the Map page; read the files meanwhile.`;
    }
    switch (input.action) {
      case "search":
        return search(graph, input.name);
      case "explain":
        return explain(graph, input.name);
      case "neighbors":
        return neighbors(graph, input.name);
      case "path":
        if (input.to === undefined) throw new UserError("path needs `to`: where the chain ends.");
        return path(graph, input.name, input.to);
    }
  }
}
