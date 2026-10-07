import { parseScope, type WikiPage, WikiPageIdSchema, type WikiToolInput } from "@majhi/shared";
import type { AgentScope } from "../memory/mcp.ts";
import type { WikiRepo } from "./repo.ts";
import type { ChunkHit, WikiIndex } from "./search.ts";
import type { WikiEnabled } from "./switch.ts";

export const WIKI_TOOL_DESCRIPTION =
  "How this project is built, written by majhi from the code with the file and lines behind every claim. " +
  "list: the pages of each project (overview, components, flows, infra, deploys, gaps) and of the workspace (how the projects connect, cross-repo flows, gaps). read: one page by id, with workspace true for a workspace page. search: the pieces of the pages that best match some words. " +
  "sources: where a claim is shown in the code. Read `deploys` before you plan or run a deploy: how the project deploys, from its CI and deploy files, with the owner's notes. It answers for this task's workspace only. A claim marked guessed was inferred, not proven: check it in the code before relying on it.";

/** A page is cut to this many characters when an agent reads it: the rest is a `search` away. */
const READ_CHARS = 12_000;
const SEARCH_HITS = 5;
const SOURCE_HITS = 3;

/** Why the tool cannot answer. The text is what the agent reads. */
export class WikiToolRefusal extends Error {}

export interface WikiToolsDeps {
  repo: WikiRepo;
  enabled: WikiEnabled;
  index: Pick<WikiIndex, "search">;
  /** Ids of a workspace's registered projects. A project taken out of majhi keeps its pages, but no agent finds them. */
  projects: (org: string) => Promise<readonly string[]>;
}

/** The place of the workspace's own pages: they have no project. */
const WORKSPACE = "";
const short = (commit: string) => commit.slice(0, 7);
const where = (s: { path: string; lines: readonly [number, number] }) =>
  `${s.path}:${s.lines[0]}-${s.lines[1]}`;

/**
 * The agent's view of the wiki (`wiki` in `majhi-memory`). The workspace comes from the task's scope, never from an
 * argument: only that workspace's projects can be named, and every read, search and source lookup is bound to them.
 * With the wiki off for the workspace the tool is not offered, and a call is refused.
 */
export class WikiTools {
  constructor(private readonly deps: WikiToolsDeps) {}

  /** Whether the tool is offered to a task: it has a workspace and that workspace has the wiki on. */
  async offered(scope: AgentScope): Promise<boolean> {
    return scope.org !== undefined && (await this.deps.enabled(scope.org));
  }

  async call(scope: AgentScope, input: WikiToolInput): Promise<string> {
    const org = scope.org;
    if (org === undefined) throw new WikiToolRefusal("This task has no workspace, so it has no wiki.");
    if (!(await this.deps.enabled(org))) throw new WikiToolRefusal("The wiki is off for this workspace.");
    const projects = this.projectsOf(scope, org, input.project, new Set(await this.deps.projects(org)));
    // The workspace's own pages are stored with no project, and searched under the empty name.
    const places =
      input.workspace === true
        ? [WORKSPACE]
        : input.project === undefined
          ? [...projects, WORKSPACE]
          : projects;
    switch (input.action) {
      case "list":
        return this.list(org, projects, input.project === undefined);
      case "read":
        return this.read(org, input.workspace === true ? [WORKSPACE] : projects, input.page);
      case "search":
        return this.search(org, places, input.words);
      case "sources":
        return this.sources(org, places, input.claim);
    }
  }

  /** The projects an answer covers: the one named when it is this workspace's, else every project of the workspace that has pages. */
  private projectsOf(
    scope: AgentScope,
    org: string,
    named: string | undefined,
    registered: ReadonlySet<string>,
  ): string[] {
    const own = scope.scopes.flatMap((s) => {
      const parsed = parseScope(s);
      return parsed?.kind === "project" && registered.has(parsed.id) ? [parsed.id] : [];
    });
    if (named !== undefined) {
      if (!own.includes(named)) {
        throw new WikiToolRefusal(
          `${named} is not a project of this task's workspace. Its projects: ${own.join(", ") || "none"}.`,
        );
      }
      return [named];
    }
    return own.filter((p) => this.deps.repo.pages(org, p).length > 0).toSorted();
  }

  private list(org: string, projects: readonly string[], withWorkspace: boolean): string {
    const workspace = withWorkspace ? this.deps.repo.pages(org, undefined) : [];
    if (projects.length === 0 && workspace.length === 0)
      return "No project of this workspace has a wiki yet.";
    const parts = projects.map((p) => {
      const pages = this.deps.repo.pages(org, p);
      const built = this.deps.repo.state(org, p).builtCommit;
      const head = `Wiki of ${p}${built === undefined ? "" : ` (built from ${short(built)})`}:`;
      return [head, ...pages.map((x) => `- ${x.id}: ${x.title}`)].join("\n");
    });
    if (workspace.length > 0) {
      parts.push(
        [
          "Wiki of the workspace (how its projects connect; read with workspace true):",
          ...workspace.map((x) => `- ${x.id}: ${x.title}`),
        ].join("\n"),
      );
    }
    return parts.join("\n\n");
  }

  /** The one project a read or lookup is about: the only one with pages, or the one the agent named. */
  private single(projects: readonly string[]): string {
    const [only, ...more] = projects;
    if (only === undefined) throw new WikiToolRefusal("No project of this workspace has a wiki yet.");
    if (more.length > 0) {
      throw new WikiToolRefusal(`Name the project: ${projects.join(", ")}.`);
    }
    return only;
  }

  private read(org: string, projects: readonly string[], pageId: string | undefined): string {
    const id = WikiPageIdSchema.safeParse(pageId);
    if (!id.success) throw new WikiToolRefusal("Give the page id from list, like overview or flow:sign-in.");
    const project = projects.length === 1 && projects[0] === WORKSPACE ? WORKSPACE : this.single(projects);
    const stored = this.deps.repo.page(org, project === WORKSPACE ? undefined : project, id.data);
    const name = project === WORKSPACE ? "The workspace" : project;
    if (stored === undefined) throw new WikiToolRefusal(`${name} has no wiki page ${id.data}. Use list.`);
    // The owner's decisions about roles show here as they do on the page.
    return pageText(this.deps.repo.shown(stored.page));
  }

  private async search(org: string, projects: readonly string[], words: string | undefined): Promise<string> {
    if (words === undefined) throw new WikiToolRefusal("Give the words to search for.");
    const hits = await this.deps.index.search({ org, projects, query: words, limit: SEARCH_HITS });
    if (hits.length === 0) return "Nothing in the wiki matches those words.";
    return hits.map((h) => this.hitText(h, projects.length > 1)).join("\n\n");
  }

  private async sources(
    org: string,
    projects: readonly string[],
    claim: string | undefined,
  ): Promise<string> {
    if (claim === undefined) throw new WikiToolRefusal("Give the words of the claim.");
    const hits = await this.deps.index.search({
      org,
      projects,
      query: claim,
      kind: "claim",
      limit: SOURCE_HITS,
    });
    if (hits.length === 0) return "No claim in the wiki matches those words.";
    return hits
      .map((h) => {
        const page = this.deps.repo.page(org, h.project === "" ? undefined : h.project, h.page)?.page;
        const found = page?.claims.find((c) => c.n === h.n);
        if (found === undefined) return `${h.text}\n  (the page changed since: read ${h.page} again)`;
        const shown = found.sources.map((s) => `  - ${where(s)} at ${short(s.commit)} (${s.repo})`);
        return [
          `${found.text}`,
          `  ${found.proven ? "proven" : "guessed"}, on ${h.project === "" ? "workspace/" : `${h.project}/`}${h.page}, claim ${found.n}`,
          ...(shown.length === 0 ? ["  no lines cited"] : shown),
        ].join("\n");
      })
      .join("\n\n");
  }

  private hitText(h: ChunkHit, named: boolean): string {
    const at = `${h.project === "" ? "workspace/" : named ? `${h.project}/` : ""}${h.page}${h.n === undefined ? "" : ` claim ${h.n}`}`;
    const text = h.text.length > 600 ? `${h.text.slice(0, 599)}…` : h.text;
    return `${at}${h.detail === "" ? "" : ` (${h.detail})`}\n${text}`;
  }
}

/** A page as an agent reads it: the text, then each claim with its status and lines. */
export function pageText(page: WikiPage): string {
  const claims = page.claims.map((c) => {
    const lines = c.sources.map(where).join(", ");
    return `[${c.n}] ${c.proven ? "proven" : "guessed"}: ${c.text}${lines === "" ? "" : ` (${lines})`}`;
  });
  const built = Object.entries(page.builtFrom)
    .map(([repo, commit]) => `${repo} at ${short(commit)}`)
    .join(", ");
  const text = [`# ${page.title} (${page.id}, built from ${built})`, "", page.body, "", ...claims].join("\n");
  return text.length > READ_CHARS ? `${text.slice(0, READ_CHARS - 1)}…\n(cut: search for the rest)` : text;
}
