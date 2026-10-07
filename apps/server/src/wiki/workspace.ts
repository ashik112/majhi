import {
  type CommitSha,
  WIKI_COST_CAP_USD,
  WIKI_RULES,
  WIKI_TOKEN_CAP,
  type WikiPage,
  type WikiPageId,
  type WikiSystemLink,
  wikiPageId,
} from "@majhi/shared";
import { errorMessage, UserError } from "../errors.ts";
import { projectGapsPage, sameGaps, saveProjectGaps } from "./derived.ts";
import { exportCommit } from "./facts/export.ts";
import { wikiCacheDir } from "./paths.ts";
import { plainReason } from "./plain-error.ts";
import { flowAlive, PLAN_TOPIC, type PlannedFlow, parseFlows, type WikiPlan } from "./plan.ts";
import type { WikiGaps } from "./repo.ts";
import { WORKSPACE_STATE } from "./repo.ts";
import type { ProjectReport, WikiProject, WikiServiceDeps } from "./service.ts";
import { Changes, staleWorkspaceReason, type WorkspaceMember } from "./stale.ts";
import { type LoadedSystem, loadSystem, readFactsFile } from "./system/load.ts";
import { plainWords } from "./writer/plain.ts";
import {
  buildWorkspaceGapsPage,
  checkWorkspacePage,
  workspaceDiagram,
  writeWorkspacePages,
} from "./writer/workspace.ts";
import {
  type WorkspaceDraft,
  type WorkspaceRepo,
  type WorkspaceWriterPage,
  workspacePageId,
} from "./writer/workspace-draft.ts";
import { LINK_LINES, workspaceFlowPrompt } from "./writer/workspace-prompt.ts";
import { tokensOf, wikiSpendId } from "./writer/write.ts";

/** What the workspace stage needs of the service. */
export type WorkspaceDeps = Pick<
  WikiServiceDeps,
  "repo" | "tasksDir" | "housekeeper" | "rest" | "index" | "changed" | "now" | "log" | "capUsd" | "capTokens"
>;

/** The cross-repo flows a workspace gets, at most. */
export const MAX_WORKSPACE_FLOWS = 5;
/** What a first build of the workspace pages is expected to write when no flows are chosen yet: the overview and a few flows. */
export const FIRST_WORKSPACE_PAGES = 4;

interface Member extends WorkspaceMember {
  project: WikiProject;
  commit: CommitSha;
}

/**
 * The workspace wiki (docs/design/wiki.md, section 5): how the projects connect, the cross-repo flows, and the gaps.
 * It runs after the projects: their facts are already stored, so the links are drawn from them with no model and
 * no reader. The writer is the same read-only Housekeeper session, with every project's export mounted. Pages whose
 * cited files did not change cost nothing, and a project update makes stale only the pages that cite that project.
 */
export class WorkspaceWiki {
  constructor(
    private readonly deps: WorkspaceDeps,
    private readonly projectsOf: (org: string) => Promise<WikiProject[]>,
  ) {}

  /** The workspace's links, drawn from the stored facts of its own projects and its own answers. */
  async system(org: string): Promise<LoadedSystem> {
    const dir = await this.deps.tasksDir();
    return loadSystem(org, {
      projects: async (o) => (await this.projectsOf(o)).map((p) => ({ id: p.id, declared: p.links ?? [] })),
      facts: (o, project) => readFactsFile(wikiCacheDir(dir, o, project)),
      answers: (o) => this.deps.repo.answers(o),
    });
  }

  private async membersOf(org: string, loaded: LoadedSystem): Promise<Member[]> {
    return (await this.projectsOf(org)).flatMap((project) => {
      const commit = loaded.commits[project.id];
      return commit === undefined
        ? []
        : [{ id: project.id, project, commit, changes: new Changes(project.path, commit) }];
    });
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /** How many workspace pages the next update would write, from git alone. */
  async pagesToWrite(org: string): Promise<number> {
    const loaded = await this.system(org);
    const members = await this.membersOf(org, loaded);
    if (members.length < 2) return 0;
    const state = this.deps.repo.state(org, WORKSPACE_STATE);
    const stored = this.deps.repo.loaded(org, undefined).filter((p) => p.kind !== "gaps");
    if (stored.length === 0) return 1 + (state.plan?.flows.length ?? FIRST_WORKSPACE_PAGES - 1);
    let n = 0;
    for (const page of stored)
      if ((await staleWorkspaceReason(page, state.rules, members)) !== undefined) n += 1;
    return n;
  }

  /**
   * Writes the workspace pages that need it and makes the Gaps page. With fewer than two projects read there is no
   * cross-repo story, so only the Gaps page is made. `page` writes only that page, whether or not it is stale.
   */
  async build(
    org: string,
    options: { replan: boolean; page?: WikiPageId | undefined },
  ): Promise<ProjectReport> {
    const { repo } = this.deps;
    const report: ProjectReport = { project: "", written: [], left: [], removed: [], usd: 0, tokens: 0 };
    const loaded = await this.system(org);
    const members = await this.membersOf(org, loaded);
    if (members.length < 2) {
      await this.redraw(org);
      return report;
    }
    const state = repo.state(org, WORKSPACE_STATE);
    const stored = new Map(repo.loaded(org, undefined).map((p) => [p.id, p]));
    const flowing = await this.flowsOf(org, state.plan, loaded, options.replan);
    const wanted: WorkspaceWriterPage[] = [
      { kind: "overview" },
      ...flowing.flows.map((f): WorkspaceWriterPage => ({ kind: "flow", ...f })),
    ];
    const gapsId = wikiPageId({ kind: "gaps" });
    if (
      options.page !== undefined &&
      options.page !== gapsId &&
      !wanted.some((w) => workspacePageId(w) === options.page)
    ) {
      throw new UserError(`There is no workspace page ${options.page} to write.`, 404);
    }

    const toWrite: WorkspaceWriterPage[] = [];
    for (const page of wanted) {
      const id = workspacePageId(page);
      const had = stored.get(id);
      if (options.page !== undefined) {
        if (id === options.page) toWrite.push(page);
        continue;
      }
      if (had === undefined || (await staleWorkspaceReason(had, state.rules, members)) !== undefined)
        toWrite.push(page);
    }

    const drafted = await this.write(org, members, loaded, toWrite, report);
    const gone = [...stored.values()]
      .filter((p) => p.kind === "flow" && !wanted.some((w) => workspacePageId(w) === p.id))
      .map((p) => p.id);
    this.store(org, loaded, state, {
      written: drafted,
      gone,
      plan: flowing.plan,
      planNote: flowing.note,
      report,
      partial: options.page !== undefined,
    });
    return report;
  }

  /** The cross-repo flows: kept from the first build, and chosen again only when the owner asks, when none were found before, or when a flow's entry is gone. */
  private async flowsOf(
    org: string,
    had: WikiPlan | undefined,
    loaded: LoadedSystem,
    replan: boolean,
  ): Promise<{ flows: PlannedFlow[]; plan: WikiPlan | undefined; note: string | undefined }> {
    const kept = replan ? [] : (had?.flows ?? []).filter((f) => flowAlive(f, loaded.facts));
    const leads = flowLeads(loaded.view.links);
    const dead = had !== undefined && kept.length < had.flows.length;
    const empty = had === undefined || had.flows.length === 0;
    if (had !== undefined && !replan && !dead && !(empty && leads.length > 0)) {
      return { flows: kept, plan: had, note: undefined };
    }
    const room = Math.max(0, MAX_WORKSPACE_FLOWS - kept.length);
    if (leads.length === 0 || room === 0) {
      return { flows: kept, plan: { flows: kept, plannedAt: this.now() }, note: undefined };
    }
    try {
      const { value } = await this.deps.housekeeper.ask(
        { id: wikiSpendId(org, undefined), org },
        workspaceFlowPrompt(org, leads, kept, room),
        parseFlows(
          new Set(leads.flatMap((l) => (l.from.fact === undefined ? [] : [l.from.fact]))),
          new Set(kept.map((f) => f.slug)),
        ),
      );
      const flows = [...kept, ...value].slice(0, MAX_WORKSPACE_FLOWS);
      return { flows, plan: { flows, plannedAt: this.now() }, note: undefined };
    } catch (err) {
      return { flows: kept, plan: had, note: `The main flows were not chosen. ${plainReason(err)}` };
    }
  }

  private async write(
    org: string,
    members: readonly Member[],
    loaded: LoadedSystem,
    pages: readonly WorkspaceWriterPage[],
    report: ProjectReport,
  ): Promise<{ pages: WikiPage[]; couldNot: WikiGaps["couldNot"]; failed: WikiGaps["failed"] }> {
    const out = {
      pages: [] as WikiPage[],
      couldNot: [] as WikiGaps["couldNot"],
      failed: [] as WikiGaps["failed"],
    };
    if (pages.length === 0) return out;
    const dir = await this.deps.tasksDir();
    const repos: WorkspaceRepo[] = [];
    for (const m of members) {
      const root = await exportCommit({
        repoPath: m.project.path,
        cacheDir: wikiCacheDir(dir, org, m.id),
        sha: m.commit,
      });
      const overview = this.deps.repo.page(org, m.id, wikiPageId({ kind: "overview" }))?.page;
      const shown = overview === undefined ? [] : this.deps.repo.shown(overview).roles;
      repos.push({
        project: m.id,
        commit: m.commit,
        root,
        roles: shown.map((r) => `${r.role} ${r.tech} (${r.where})`),
      });
    }
    const [head, ...tail] = repos;
    if (head === undefined) return out;
    const wrote = await writeWorkspacePages({
      housekeeper: this.deps.housekeeper,
      org,
      repos: [head, ...tail],
      system: loaded.view,
      pages,
      capUsd: this.deps.capUsd ?? WIKI_COST_CAP_USD,
      capTokens: this.deps.capTokens ?? WIKI_TOKEN_CAP,
      stop: () => this.deps.rest(org),
    });
    report.stopped = wrote.stopped;
    report.usd += wrote.usage.costUsd;
    report.tokens += tokensOf(wrote.usage);
    out.failed.push(...wrote.failed);
    report.left.push(...wrote.skipped, ...wrote.failed.map((f) => f.page));

    const plain = await plainWords({
      housekeeper: this.deps.housekeeper,
      org,
      project: undefined,
      drafts: wrote.drafts,
    }).catch(() => ({ drafts: wrote.drafts, unchanged: [], usage: undefined }));
    if (plain.usage !== undefined) {
      report.usd += plain.usage.costUsd;
      report.tokens += tokensOf(plain.usage);
    }
    for (const draft of plain.drafts) {
      out.pages.push(await checkWorkspacePage(draft, repos, loaded.view, org));
      out.couldNot.push(...couldNotOf(draft));
    }
    return out;
  }

  /** Saves the run in one transaction: pages, the Gaps page, the flow pages that are gone, and the workspace's state. */
  private store(
    org: string,
    loaded: LoadedSystem,
    before: ReturnType<WorkspaceDeps["repo"]["state"]>,
    run: {
      written: { pages: WikiPage[]; couldNot: WikiGaps["couldNot"]; failed: WikiGaps["failed"] };
      gone: WikiPageId[];
      plan: WikiPlan | undefined;
      planNote: string | undefined;
      report: ProjectReport;
      partial: boolean;
    },
  ): void {
    const { repo } = this.deps;
    const { written, report } = run;
    const rewritten = new Set<WikiPageId>(written.pages.map((p) => p.id));
    const failedNow = new Set<WikiPageId>(written.failed.map((f) => f.page));
    const keep = (page: WikiPageId) =>
      !rewritten.has(page) && !failedNow.has(page) && !run.gone.includes(page);
    const gaps: WikiGaps = {
      couldNot: [...before.gaps.couldNot.filter((c) => keep(c.page)), ...written.couldNot].filter(
        (c) => c.topic !== PLAN_TOPIC,
      ),
      failed: [...before.gaps.failed.filter((f) => keep(f.page)), ...written.failed],
    };
    if (run.planNote !== undefined) {
      gaps.couldNot.push({ page: wikiPageId({ kind: "overview" }), topic: PLAN_TOPIC, why: run.planNote });
    }
    const left = report.left.length;
    const lastError =
      report.stopped !== undefined
        ? `Stopped: ${report.stopped}. ${left} ${left === 1 ? "page was" : "pages were"} not written. Update again to continue.`
        : left > 0
          ? `${left} ${left === 1 ? "page was" : "pages were"} not written. Update again to try them again.`
          : undefined;
    repo.transaction(() => {
      for (const page of written.pages) repo.save(page);
      for (const id of run.gone) repo.remove(org, undefined, id);
      this.saveGaps(org, loaded, gaps);
      repo.saveState(org, WORKSPACE_STATE, {
        sources: {},
        // A run of one page leaves the others as stale as they were.
        rules: run.partial ? before.rules : WIKI_RULES,
        ...(run.plan === undefined ? {} : { plan: run.plan }),
        gaps,
        ...(lastError === undefined ? {} : { lastError }),
        updatedAt: this.now(),
      });
    });
    report.written = written.pages.map((p) => p.id);
    report.removed = [...run.gone];
    this.reindex(org, [...written.pages.map((p) => p.id)], run.gone);
  }

  private saveGaps(org: string, loaded: LoadedSystem, gaps: WikiGaps): WikiPage | undefined {
    const { repo } = this.deps;
    if (Object.keys(loaded.commits).length === 0) return undefined;
    const pages = repo.loaded(org, undefined).filter((p) => p.kind !== "gaps");
    const page = buildWorkspaceGapsPage({
      org,
      builtFrom: loaded.commits,
      pages,
      system: loaded.view,
      couldNot: gaps.couldNot,
      failed: gaps.failed,
    });
    const had = repo.page(org, undefined, page.id)?.page;
    if (had !== undefined && sameGaps(had, page)) return undefined;
    repo.save(page);
    return page;
  }

  /** The search index follows the store: written pages in, removed pages out, and the Gaps page. A failure here never loses the pages. */
  private reindex(org: string, written: readonly WikiPageId[], gone: readonly WikiPageId[]): void {
    const index = this.deps.index;
    if (index === undefined) return;
    for (const id of gone) index.drop(org, undefined, id);
    const ids = new Set<WikiPageId>([...written, wikiPageId({ kind: "gaps" })]);
    for (const page of this.deps.repo.loaded(org, undefined).filter((p) => ids.has(p.id))) {
      void index
        .put(page)
        .catch((err: unknown) => this.deps.log?.(`wiki: indexing ${page.id}: ${errorMessage(err)}`));
    }
  }

  /**
   * Draws what depends on the links again, with no model: every project's Gaps page (its unlinked calls and roles still
   * to confirm), the workspace overview's picture, and the workspace Gaps page. Pages that come out the same are not saved.
   */
  async redraw(org: string): Promise<void> {
    const { repo } = this.deps;
    const loaded = await this.system(org);
    const projects = await this.projectsOf(org);
    for (const p of projects) {
      const state = repo.state(org, p.id);
      if (state.builtCommit === undefined) continue;
      const page = projectGapsPage(repo, {
        org,
        project: p.id,
        commit: state.builtCommit,
        view: loaded.view,
        gaps: state.gaps,
      });
      if (saveProjectGaps(repo, page)) this.reindexProject(org, p.id);
    }
    const overview = repo.loaded(org, undefined).find((p) => p.id === wikiPageId({ kind: "overview" }));
    if (overview !== undefined) {
      const guessed = (overview.diagrams[0]?.edges ?? [])
        .filter((e) => e.style === "dotted")
        .map((e) => ({ from: e.from, to: e.to, label: e.label }));
      const diagram = workspaceDiagram(Object.keys(loaded.commits), overview.roles, loaded.view, guessed);
      if (JSON.stringify(diagram) !== JSON.stringify(overview.diagrams[0])) {
        repo.save({ ...overview, diagrams: [diagram, ...overview.diagrams.slice(1)] });
        this.reindex(org, [overview.id], []);
      }
    }
    const state = repo.state(org, WORKSPACE_STATE);
    if (this.saveGaps(org, loaded, state.gaps) !== undefined) this.reindex(org, [], []);
    this.deps.changed();
  }

  private reindexProject(org: string, project: string): void {
    const index = this.deps.index;
    const gaps = this.deps.repo.loaded(org, project).find((p) => p.kind === "gaps");
    if (index !== undefined && gaps !== undefined) {
      void index
        .put(gaps)
        .catch((err: unknown) => this.deps.log?.(`wiki: indexing ${gaps.id}: ${errorMessage(err)}`));
    }
  }
}

/** The links the flow chooser sees: a call (or address) on the first side with its id, one per place, a spread of the pairs of projects. */
export function flowLeads(links: readonly WikiSystemLink[]): WikiSystemLink[] {
  const seen = new Set<string>();
  const out: WikiSystemLink[] = [];
  for (const l of links) {
    if (l.from.fact === undefined || l.basis === "declared") continue;
    const key = `${l.from.project}>${l.to.project}:${l.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  const pairs = new Map<string, WikiSystemLink[]>();
  for (const l of out)
    pairs.set(`${l.from.project}>${l.to.project}`, [
      ...(pairs.get(`${l.from.project}>${l.to.project}`) ?? []),
      l,
    ]);
  const spread: WikiSystemLink[] = [];
  for (let i = 0; spread.length < LINK_LINES; i++) {
    const row = [...pairs.values()].flatMap((group) =>
      group[i] === undefined ? [] : [group[i] as WikiSystemLink],
    );
    if (row.length === 0) break;
    spread.push(...row);
  }
  return spread.slice(0, LINK_LINES);
}

function couldNotOf(draft: WorkspaceDraft): WikiGaps["couldNot"] {
  return draft.couldNot.map((c) => ({
    page: draft.id,
    topic: c.topic.slice(0, 300),
    why: c.why.slice(0, 600),
  }));
}
