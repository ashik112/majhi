import {
  type CommitSha,
  type Price,
  WIKI_COST_CAP_USD,
  WIKI_RULES,
  WIKI_TOKEN_CAP,
  type WikiEstimate,
  type WikiFact,
  type WikiFactKind,
  type WikiPage,
  type WikiPageId,
  type WikiPhase,
  wikiPageId,
} from "@majhi/shared";
import { errorMessage, UserError } from "../errors.ts";
import { Background } from "../memory/background.ts";
import type { Housekeeper } from "../memory/housekeeper.ts";
import type { FactsReader, ReaderRun } from "../reader/run.ts";
import { exportCommit, pruneExports } from "./facts/export.ts";
import { extractFacts } from "./facts/extract.ts";
import { ProjectFiles } from "./facts/files.ts";
import { branchTip, changedFiles } from "./git.ts";
import { wikiCacheDir } from "./paths.ts";
import {
  flowAlive,
  flowLeads,
  flowPrompt,
  type PlannedFlow,
  parseFlows,
  planComponents,
  type WikiPlan,
  writerPages,
} from "./plan.ts";
import type { WikiGaps, WikiRepo, WikiState } from "./repo.ts";
import type { WikiEnabled } from "./switch.ts";
import { checkPage } from "./writer/check.ts";
import { type DraftPage, type WriterPage, writerPageId } from "./writer/draft.ts";
import { buildGapsPage } from "./writer/gaps.ts";
import { hintFacts } from "./writer/hints.ts";
import { plainWords } from "./writer/plain.ts";
import { tokensOf, wikiSpendId, writePages } from "./writer/write.ts";

/** What phase 0 measured for the writer: tokens for one page. The estimate multiplies it by the pages to write. */
export const TOKENS_PER_PAGE = 45_000;
/** Pages a first build is expected to write (overview, infra, a handful of components and the main flows), for an estimate made before the facts are read. */
export const FIRST_BUILD_PAGES = 12;
/** The share of a page's tokens that is input, for pricing: reading code dominates writing. */
const INPUT_SHARE = 0.85;

/** The sealed reader the service needs: the facts, and the code graph kept fresh for `code_graph`. */
export interface WikiReader extends FactsReader {
  updateGraph(exportDir: string, cacheDir: string): Promise<ReaderRun>;
}

export interface WikiProject {
  id: string;
  org: string;
  path: string;
  base: string | undefined;
  exists: boolean;
}

/** What the search index keeps of the pages, so agents can search them. */
export interface PageIndex {
  put(page: WikiPage): Promise<void>;
  drop(org: string, project: string | undefined, id: WikiPageId): void;
}

export interface WikiServiceDeps {
  repo: WikiRepo;
  enabled: WikiEnabled;
  projects: () => Promise<readonly WikiProject[]>;
  tasksDir: () => Promise<string>;
  /** Absent unless agents run in containers: the wiki then says it needs container mode and runs nothing. */
  reader: WikiReader | undefined;
  /** The writer: a read-only session of the Housekeeper, and its one cheap question for the main flows. */
  housekeeper: Pick<Housekeeper, "session" | "ask">;
  /** Why the workspace's budget has no room, or undefined. Asked before each page. */
  rest: (org: string) => Promise<string | undefined>;
  /** Why no writer can run for the workspace (no Housekeeper set, one that may not work there), or undefined. */
  unavailable: (org: string) => Promise<string | undefined>;
  /** What the writer's model costs per million tokens. Absent: the estimate has no dollars and only the token cap holds. */
  price: (org: string) => Promise<Price | undefined>;
  index?: PageIndex | undefined;
  /** The wiki changed (progress, pages, state): the UI refetches. */
  changed: () => void;
  now?: () => Date;
  log?: (message: string) => void;
  /** Tests lower the caps. */
  capUsd?: number;
  capTokens?: number;
}

/** What one project's update did. */
export interface ProjectReport {
  project: string;
  /** The commit it read. Absent when the update stopped before reading anything. */
  commit?: CommitSha | undefined;
  written: WikiPageId[];
  /** Pages the writer could not give or that the cap, the budget or a failed session left for the next update. */
  left: WikiPageId[];
  removed: WikiPageId[];
  /** What the facts pass found, per kind. Absent when it did not run. */
  facts?: Record<WikiFactKind, number> | undefined;
  stopped?: string | undefined;
  usd: number;
  tokens: number;
}

export interface WikiRunning {
  phase: WikiPhase;
  done: number;
  total: number;
}

/**
 * The wiki's update (docs/design/wiki.md, section 3): facts, plan, write, check, store, one project at a time and
 * one run per workspace at a time (a second update waits for the first and then finds little to do). Pages whose
 * cited files did not change cost nothing, and a run on a commit that was already read writes nothing.
 */
export class WikiService {
  private readonly background = new Background();
  /** The last run of each workspace: the next one starts after it. */
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly running = new Map<string, WikiRunning>();
  private readonly graphing = new Set<string>();

  constructor(private readonly deps: WikiServiceDeps) {}

  /** Resolves when every run and graph refresh has ended: shutdown waits for it. */
  settled(): Promise<void> {
    return this.background.settled();
  }

  /** Where an update of a project is now, or undefined when none is running. */
  progress(org: string, project: string): WikiRunning | undefined {
    return this.running.get(`${org}/${project}`);
  }

  /**
   * Why an update cannot start, as a `UserError`, so a click answers at once: no container mode, no writer, an
   * unknown project, a project with no checkout or base branch.
   */
  async preflight(org: string, project?: string): Promise<void> {
    if (this.deps.reader === undefined) {
      throw new UserError(
        "The wiki needs container mode: it reads the code in a sealed container that has no network. Turn on containers for agents in Settings, then update again.",
        409,
      );
    }
    const found = await this.projectsOf(org, project);
    if (found.length === 0) {
      throw new UserError(
        project === undefined
          ? "This workspace has no projects on this computer to read."
          : `"${project}" is not a project of workspace "${org}".`,
        project === undefined ? 409 : 404,
      );
    }
    for (const p of found) {
      if (!p.exists) throw new UserError(`The checkout of ${p.id} is missing.`, 409);
      if (p.base === undefined) throw new UserError(`${p.id} has no base branch to read.`, 409);
    }
    const why = await this.deps.unavailable(org);
    if (why !== undefined) throw new UserError(why, 409);
  }

  /**
   * Starts an update of one project of a workspace, or of each of its projects in turn, and answers once it is
   * queued: the projects show as running at once. It throws what `preflight` throws. The run waits for one that is
   * already going in the workspace. A failed project keeps its error as `lastError`, and `finished` rejects with it.
   */
  async start(
    org: string,
    project?: string,
    options: { replan?: boolean } = {},
  ): Promise<{ finished: Promise<ProjectReport[]> }> {
    await this.preflight(org, project);
    const targets = await this.projectsOf(org, project);
    for (const p of targets) this.step(p, "facts", 0, 1);
    const before = this.tails.get(org) ?? Promise.resolve();
    const run = before
      .catch(() => undefined)
      .then(async () => {
        const reports: ProjectReport[] = [];
        for (const p of targets) reports.push(await this.runProject(p, options.replan === true));
        return reports;
      });
    this.tails.set(org, run);
    void run
      .catch(() => undefined)
      .finally(() => {
        if (this.tails.get(org) === run) this.tails.delete(org);
      });
    return { finished: this.background.track(run) };
  }

  /** `start`, and waits for the run to end. */
  async update(org: string, project?: string, options: { replan?: boolean } = {}): Promise<ProjectReport[]> {
    return (await this.start(org, project, options)).finished;
  }

  /** The base branch of a project moved: the pages may now be behind, so the UI looks again. */
  tipMoved(): void {
    this.deps.changed();
  }

  /** Projects of a workspace with a wiki that is behind the base branch (or written by older rules): what Auto-pilot would update. */
  async stale(org: string): Promise<{ projects: string[]; commits: number }> {
    const out: string[] = [];
    let commits = 0;
    for (const p of await this.projectsOf(org, undefined)) {
      const state = this.deps.repo.state(org, p.id);
      if (state.builtCommit === undefined || !p.exists || p.base === undefined) continue;
      const tip = await branchTip(p.path, p.base);
      if (tip === undefined) continue;
      if (tip !== state.builtCommit || state.rules !== WIKI_RULES) {
        out.push(p.id);
        commits += 1;
      }
    }
    return { projects: out, commits };
  }

  /**
   * What the next update would write and cost, without reading the code: the stored pages whose cited files changed
   * since each was built (git only), or a first build's usual size. The estimate is tokens at the phase 0 measure,
   * and dollars when the writer's model has a price.
   */
  async estimate(org: string, project?: string): Promise<WikiEstimate> {
    const projects = await this.projectsOf(org, project);
    const cap = this.deps.capUsd ?? WIKI_COST_CAP_USD;
    const capTokens = this.deps.capTokens ?? WIKI_TOKEN_CAP;
    let pages = 0;
    for (const p of projects) pages += await this.pagesToWrite(p);
    const tokens = pages * TOKENS_PER_PAGE;
    const price = await this.deps.price(org);
    const usd =
      price === undefined
        ? undefined
        : (tokens * (INPUT_SHARE * price.input + (1 - INPUT_SHARE) * price.output)) / 1_000_000;
    const note =
      projects.length === 0
        ? "This workspace has no projects on this computer."
        : pages === 0
          ? "Nothing changed since the last update."
          : await this.deps.unavailable(org);
    return {
      projects: projects.length,
      pages,
      tokens,
      ...(usd === undefined ? {} : { usd }),
      cap,
      overCap: (usd !== undefined && usd > cap) || tokens > capTokens,
      ...(note === undefined ? {} : { note }),
    };
  }

  // ---------------------------------------------------------------------------------------

  private async projectsOf(org: string, project: string | undefined): Promise<WikiProject[]> {
    return (await this.deps.projects())
      .filter((p) => p.org === org && (project === undefined || p.id === project))
      .toSorted((a, b) => a.id.localeCompare(b.id));
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private step(p: WikiProject, phase: WikiPhase, done: number, total: number): void {
    this.running.set(`${p.org}/${p.id}`, { phase, done, total });
    this.deps.changed();
  }

  /** How many pages the next update of a project would write, from git alone. */
  private async pagesToWrite(p: WikiProject): Promise<number> {
    const state = this.deps.repo.state(p.org, p.id);
    const stored = this.deps.repo.loaded(p.org, p.id).filter((page) => page.kind !== "gaps");
    if (stored.length === 0 || state.builtCommit === undefined) return FIRST_BUILD_PAGES;
    const tip = p.base === undefined ? undefined : await branchTip(p.path, p.base);
    if (tip === undefined) return 0;
    const changes = new Changes(p.path, tip);
    let n = 0;
    for (const page of stored) {
      const sources = state.sources[page.id] ?? citedPaths(page);
      if ((await staleReason(page, sources, [], p.id, state.rules, changes)) !== undefined) n += 1;
    }
    return n;
  }

  private async runProject(p: WikiProject, replan: boolean): Promise<ProjectReport> {
    const { repo } = this.deps;
    const report: ProjectReport = { project: p.id, written: [], left: [], removed: [], usd: 0, tokens: 0 };
    try {
      await this.preflight(p.org, p.id);
      return await this.build(p, replan, report);
    } catch (err) {
      const state = repo.state(p.org, p.id);
      repo.saveState(p.org, p.id, {
        ...state,
        lastError: errorMessage(err).slice(0, 500),
        updatedAt: this.now(),
      });
      throw err;
    } finally {
      this.running.delete(`${p.org}/${p.id}`);
      this.deps.changed();
    }
  }

  private async build(p: WikiProject, replan: boolean, report: ProjectReport): Promise<ProjectReport> {
    const { repo, reader } = this.deps;
    if (reader === undefined || p.base === undefined) throw new UserError("The wiki cannot run here.", 409);
    this.step(p, "facts", 0, 1);
    const tip = await branchTip(p.path, p.base);
    if (tip === undefined) throw new UserError(`${p.id} has no commit on ${p.base} to read.`, 409);
    report.commit = tip;
    const state = repo.state(p.org, p.id);
    const stored = new Map(repo.loaded(p.org, p.id).map((page) => [page.id, page]));

    // Nothing moved since the last complete update: nothing to read, nothing to write.
    if (
      state.builtCommit === tip &&
      state.rules === WIKI_RULES &&
      state.lastError === undefined &&
      !replan &&
      stored.size > 0
    ) {
      return report;
    }

    const cacheDir = wikiCacheDir(await this.deps.tasksDir(), p.org, p.id);
    const exportDir = await exportCommit({ repoPath: p.path, cacheDir, sha: tip });
    const { file, report: found } = await extractFacts(
      { org: p.org, project: p.id, exportDir, cacheDir, sha: tip },
      reader,
    );
    report.facts = found.counts;
    this.refreshGraph(p, exportDir, cacheDir);

    // Plan: which pages exist, and which of them the code moved under.
    this.step(p, "plan", 0, 1);
    const files = (await new ProjectFiles(exportDir).walk("", { maxDepth: 10, limit: 80_000 })).files;
    const components = planComponents(file.facts, files);
    const flowing = await this.flowsOf(p, state, file.facts, replan);
    const wanted = writerPages(components, flowing.flows);
    const changes = new Changes(p.path, tip);
    const toWrite: WriterPage[] = [];
    for (const page of wanted) {
      const id = writerPageId(page);
      const had = stored.get(id);
      const leads = hintFacts(page, file.facts).flatMap((f) => f.sources.map((s) => s.path));
      const why =
        had === undefined
          ? "new"
          : await staleReason(had, state.sources[id] ?? citedPaths(had), leads, p.id, state.rules, changes);
      if (why !== undefined) toWrite.push(page);
    }

    // Write, check, store.
    const written = await this.write(p, tip, exportDir, file.facts, toWrite, report);
    const gone = [...stored.values()]
      .filter((page) => page.kind !== "gaps" && !wanted.some((w) => writerPageId(w) === page.id))
      .map((page) => page.id);
    this.step(p, "store", 0, 1);
    this.store(p, tip, state, { written, gone, wanted, plan: flowing.plan, planNote: flowing.note, report });
    // Exports of commits no page was built from any more are removed; each page's source chips read the export it was built from.
    const built = new Set(repo.loaded(p.org, p.id).flatMap((page) => Object.values(page.builtFrom)));
    await pruneExports(cacheDir, [tip, ...built]);
    return report;
  }

  /** The graph for `code_graph`, refreshed after the facts, off the critical path: the pages never wait for it. */
  private refreshGraph(p: WikiProject, exportDir: string, cacheDir: string): void {
    const key = `${p.org}/${p.id}`;
    if (this.graphing.has(key) || this.deps.reader === undefined) return;
    this.graphing.add(key);
    const job = this.deps.reader
      .updateGraph(exportDir, cacheDir)
      .then((run) => {
        if (!run.ok) this.deps.log?.(`wiki: the code graph of ${p.id} was not refreshed: ${run.reason}`);
      })
      .catch((err: unknown) => this.deps.log?.(`wiki: the code graph of ${p.id}: ${errorMessage(err)}`))
      .finally(() => this.graphing.delete(key));
    void this.background.track(job);
  }

  /**
   * The main flows: kept from the first build, and chosen again only when the owner asks, when none were found
   * before, or when a flow's entry facts are gone from the code (the surviving flows keep their pages).
   */
  private async flowsOf(
    p: WikiProject,
    state: WikiState,
    facts: readonly WikiFact[],
    replan: boolean,
  ): Promise<{ flows: PlannedFlow[]; plan: WikiPlan | undefined; note: string | undefined }> {
    const had = state.plan;
    const kept = replan ? [] : (had?.flows ?? []).filter((f) => flowAlive(f, facts));
    const leads = flowLeads(facts);
    const dead = had !== undefined && kept.length < had.flows.length;
    const empty = had === undefined || had.flows.length === 0;
    if (had !== undefined && !replan && !dead && !(empty && leads.length > 0)) {
      return { flows: kept, plan: had, note: undefined };
    }
    const room = Math.max(0, 5 - kept.length);
    if (leads.length === 0 || room === 0) {
      return { flows: kept, plan: { flows: kept, plannedAt: this.now() }, note: undefined };
    }
    this.step(p, "plan", 0, 1);
    try {
      const { value } = await this.deps.housekeeper.ask(
        { id: wikiSpendId(p.org, p.id), org: p.org, project: p.id },
        flowPrompt(p.id, leads, kept, room),
        parseFlows(new Set(leads.map((l) => l.id)), new Set(kept.map((f) => f.slug))),
      );
      const flows = [...kept, ...value].slice(0, 5);
      return { flows, plan: { flows, plannedAt: this.now() }, note: undefined };
    } catch (err) {
      // The plan is not kept: the next update asks again. Pages of the flows that survive are still written.
      return { flows: kept, plan: had, note: `The main flows were not chosen: ${errorMessage(err)}` };
    }
  }

  private async write(
    p: WikiProject,
    tip: CommitSha,
    exportDir: string,
    facts: readonly WikiFact[],
    pages: readonly WriterPage[],
    report: ProjectReport,
  ): Promise<{ pages: WikiPage[]; couldNot: WikiGaps["couldNot"]; failed: WikiGaps["failed"] }> {
    const out = {
      pages: [] as WikiPage[],
      couldNot: [] as WikiGaps["couldNot"],
      failed: [] as WikiGaps["failed"],
    };
    if (pages.length === 0) return out;
    this.step(p, "write", 0, pages.length);
    const wrote = await writePages({
      housekeeper: this.deps.housekeeper,
      org: p.org,
      project: p.id,
      sha: tip,
      exportDir,
      facts,
      pages,
      capUsd: this.deps.capUsd ?? WIKI_COST_CAP_USD,
      capTokens: this.deps.capTokens ?? WIKI_TOKEN_CAP,
      stop: () => this.deps.rest(p.org),
      progress: (done, total) => this.step(p, "write", done, total),
    });
    report.stopped = wrote.stopped;
    report.usd += wrote.usage.costUsd;
    report.tokens += tokensOf(wrote.usage);
    out.failed.push(...wrote.failed);
    report.left.push(...wrote.skipped, ...wrote.failed.map((f) => f.page));

    const plain = await plainWords({
      housekeeper: this.deps.housekeeper,
      org: p.org,
      project: p.id,
      drafts: wrote.drafts,
    }).catch(() => ({ drafts: wrote.drafts, unchanged: [], usage: undefined }));
    if (plain.usage !== undefined) {
      report.usd += plain.usage.costUsd;
      report.tokens += tokensOf(plain.usage);
    }

    this.step(p, "check", 0, plain.drafts.length);
    for (const [i, draft] of plain.drafts.entries()) {
      out.pages.push(await checkPage(draft, exportDir));
      out.couldNot.push(...couldNotOf(draft));
      this.step(p, "check", i + 1, plain.drafts.length);
    }
    return out;
  }

  /** Saves the run in one transaction: pages, the gaps page, the pages that are gone, and the project's state. */
  private store(
    p: WikiProject,
    tip: CommitSha,
    before: WikiState,
    run: {
      written: { pages: WikiPage[]; couldNot: WikiGaps["couldNot"]; failed: WikiGaps["failed"] };
      gone: WikiPageId[];
      wanted: readonly WriterPage[];
      plan: WikiPlan | undefined;
      planNote: string | undefined;
      report: ProjectReport;
    },
  ): void {
    const { repo } = this.deps;
    const { written, report } = run;
    const rewritten = new Set<WikiPageId>(written.pages.map((page) => page.id));
    const failedNow = new Set<WikiPageId>(written.failed.map((f) => f.page));
    const sources = { ...before.sources };
    for (const page of written.pages) sources[page.id] = citedPaths(page);
    for (const id of run.gone) delete sources[id];
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
      for (const id of run.gone) repo.remove(p.org, p.id, id);
      const pages = repo.loaded(p.org, p.id).filter((page) => page.kind !== "gaps");
      const gapsPage = buildGapsPage({
        org: p.org,
        project: p.id,
        commit: tip,
        pages,
        couldNot: gaps.couldNot,
        failed: gaps.failed,
      });
      const had = repo.page(p.org, p.id, gapsPage.id)?.page;
      // The gaps page names the commit it was made at; a commit that changed nothing on it is not a new version.
      if (had === undefined || !sameGaps(had, gapsPage)) repo.save(gapsPage);
      repo.saveState(p.org, p.id, {
        builtCommit: tip,
        sources,
        rules: WIKI_RULES,
        ...(run.plan === undefined ? {} : { plan: run.plan }),
        gaps,
        ...(lastError === undefined ? {} : { lastError }),
        updatedAt: this.now(),
      });
    });
    report.written = written.pages.map((page) => page.id);
    report.removed = [...run.gone];
    // The search index follows the store: written pages in, removed pages out. A failure here never loses the pages.
    const index = this.deps.index;
    if (index !== undefined) {
      for (const id of run.gone) index.drop(p.org, p.id, id);
      for (const page of [...written.pages, ...repo.loaded(p.org, p.id).filter((x) => x.kind === "gaps")]) {
        void index
          .put(page)
          .catch((err: unknown) => this.deps.log?.(`wiki: indexing ${page.id}: ${errorMessage(err)}`));
      }
    }
  }
}

const PLAN_TOPIC = "Main flows";

/** The repo files a page cites, once each: its claims' sources and what its dropped claims pointed at. */
export function citedPaths(page: WikiPage): string[] {
  return [
    ...new Set([
      ...page.claims.flatMap((c) => c.sources.map((s) => s.path)),
      ...page.dropped.flatMap((d) => d.cited.map((c) => c.path)),
    ]),
  ];
}

function couldNotOf(draft: DraftPage): WikiGaps["couldNot"] {
  return draft.couldNot.map((c) => ({
    page: draft.id,
    topic: c.topic.slice(0, 300),
    why: c.why.slice(0, 600),
  }));
}

/** Two gaps pages say the same when everything but the commit they were made at is equal. */
function sameGaps(a: WikiPage, b: WikiPage): boolean {
  return a.body === b.body && JSON.stringify(a.dropped) === JSON.stringify(b.dropped) && a.v === b.v;
}

/** Files changed between a commit and the tip, asked once per commit. */
export class Changes {
  private readonly seen = new Map<string, Promise<ReadonlySet<string> | undefined>>();

  constructor(
    private readonly repoPath: string,
    private readonly tip: string,
  ) {}

  since(commit: string): Promise<ReadonlySet<string> | undefined> {
    let got = this.seen.get(commit);
    if (got === undefined) {
      got = changedFiles(this.repoPath, commit, this.tip).then((files) =>
        files === undefined ? undefined : new Set(files),
      );
      this.seen.set(commit, got);
    }
    return got;
  }
}

/**
 * Why a stored page must be written again, or undefined when it stands: it was written by older rules, the commit
 * it was built from is gone, or a file it cites (or a file that now gives the facts it starts from) changed since.
 */
export async function staleReason(
  page: WikiPage,
  sources: readonly string[],
  leads: readonly string[],
  project: string,
  rules: number,
  changes: Changes,
): Promise<"rules" | "history" | "changed" | undefined> {
  if (page.v !== WIKI_RULES || rules !== WIKI_RULES) return "rules";
  const built = page.builtFrom[project];
  if (built === undefined) return "history";
  const changed = await changes.since(built);
  if (changed === undefined) return "history";
  return [...sources, ...leads].some((path) => changed.has(path)) ? "changed" : undefined;
}
