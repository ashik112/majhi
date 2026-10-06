import { createHash } from "node:crypto";
import {
  isLoopbackHost,
  MAP_COST_CAP_USD,
  MAP_TOGETHER_MIN,
  type MapAnswer,
  type MapEndpoint,
  type MapEstimate,
  type MapReport,
  type MapRole,
  type MapRunning,
  type MapTask,
  type MapView,
  type Price,
  type ProjectMap,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { Parsed } from "../memory/housekeeper.ts";
import {
  type CodeFile,
  fitBudget,
  type Proposal,
  parseProposal,
  proposalPrompt,
  selectFiles,
} from "./code.ts";
import { LoadCache } from "./config/facts.ts";
import { splitSpaces } from "./config/formats.ts";
import { type ConfigResult, configPass, type ProjectInput } from "./config/pass.ts";
import { parseAddress } from "./endpoints.ts";
import { ProjectFiles } from "./files.ts";
import { graphEndpoints } from "./graph/facts.ts";
import type { GraphRunner } from "./graph/run.ts";
import { answerAddress, confirmEdge, mergeMap, removeEdge, setRole } from "./merge.ts";
import type { MapRepo } from "./repo.ts";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** An estimate is kept this long: opening the page twice reads the checkouts once. */
const ESTIMATE_TTL_MS = 30_000;

/** The model call: the Housekeeper's, which runs the smallest model the account offers with no tools. */
export type Ask = <T>(
  task: { id: string; org: string },
  prompt: string,
  parse: (reply: string) => Parsed<T>,
) => Promise<{ value: T }>;

export interface MapTaskFact {
  id: string;
  title: string;
  status: string;
  org?: string | undefined;
  repos: readonly { project: string }[];
  chat?: boolean | undefined;
  lane?: boolean | undefined;
}

export interface MapDeps {
  repo: MapRepo;
  /** Every registered project. The map reads only the workspace's own. */
  projects: () => Promise<{ id: string; org: string; path: string; exists: boolean }[]>;
  /** Tasks that are not done. */
  tasks: () => MapTaskFact[];
  /** The model call. Absent: the update is config and history only. */
  ask?: Ask | undefined;
  /** Why the code pass cannot run now (no model set, none that may work here), or undefined. */
  unavailable: (org: string) => Promise<string | undefined>;
  /** What the model costs per million tokens. Absent: the estimate has no dollars and only the token limit holds. */
  price: (org: string) => Promise<Price | undefined>;
  /** Dollars spent under a usage task id since a moment. */
  spent: (task: string, since: string) => number;
  changed: () => void;
  now?: () => Date;
  remotes?: (path: string) => Promise<string[]>;
  /** The most one update spends. Tests lower it. */
  cap?: number;
  /**
   * Reads each project's code with graphify in a runner container (free, no model). Absent when majhi
   * does not run agents in containers: the update then has no graph pass.
   */
  graph?: GraphRunner | undefined;
}

const usageTask = (org: string) => `map:${org}`;

/** A hash of the files sent for one project: the same hash means the model would read the same thing. */
function hashOf(files: readonly CodeFile[]): string {
  const h = createHash("sha1");
  for (const f of files.toSorted((a, b) => a.path.localeCompare(b.path))) {
    h.update(f.path);
    h.update("\0");
    h.update(f.lines.join("\n"));
    h.update("\0");
  }
  return h.digest("hex");
}

/** One short line of plain text: no breaks, cut at `max`. */
function oneLine(text: string, max: number): string {
  const flat = splitSpaces(text).join(" ");
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * The project map of each workspace (SPEC 5.21). One stored map per workspace; one action updates it.
 * Everything here is scoped by `org`: a workspace's projects, tasks and map never mix with another's.
 */
export class MapService {
  private readonly running = new Map<string, MapRunning>();
  private readonly updating = new Map<string, Promise<MapView>>();
  private readonly estimates = new Map<string, { at: number; value: MapEstimate }>();
  /** Config files read per checkout, kept while their size and time stay the same. */
  private readonly cache = new LoadCache();
  /** What the model last read of each project, by hash: unchanged files are not sent again. */
  private readonly read = new Map<string, string>();
  /** Why the last background update of a workspace failed, until the next one starts. */
  private readonly failed = new Map<string, string>();

  constructor(private readonly deps: MapDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private cap(): number {
    return this.deps.cap ?? MAP_COST_CAP_USD;
  }

  private async inputs(org: string): Promise<ProjectInput[]> {
    return (await this.deps.projects())
      .filter((p) => p.org === org && p.exists)
      .map((p) => ({ id: p.id, path: p.path }))
      .toSorted((a, b) => a.id.localeCompare(b.id));
  }

  /** The page's one read. */
  async view(org: string): Promise<MapView> {
    const stored = this.deps.repo.get(org);
    const all = (await this.deps.projects()).filter((p) => p.org === org);
    const tasks = this.deps
      .tasks()
      .filter((t) => (t.org ?? "private") === org && t.chat !== true && t.lane !== true)
      .map(
        (t): MapTask => ({
          id: t.id,
          title: t.title,
          status: t.status,
          projects: t.repos.map((r) => r.project),
        }),
      )
      .filter((t) => t.projects.length > 0);
    const weekAgo = new Date(this.now().getTime() - WEEK_MS).toISOString();
    const running = this.running.get(org);
    return {
      org,
      map: stored.map,
      ...(stored.updatedAt === undefined ? {} : { updatedAt: stored.updatedAt }),
      mergesSince: this.deps.repo.mergesSince(org, stored.updatedAt),
      ...(running === undefined ? {} : { running }),
      ...(this.failed.has(org) ? { failed: this.failed.get(org) as string } : {}),
      ...(stored.report === undefined ? {} : { report: stored.report }),
      tasks,
      changedThisWeek: this.deps.repo.changedSince(org, weekAgo).map((c) => c.project),
      projects: all.map((p) => ({ id: p.id, path: p.path, exists: p.exists })),
    };
  }

  /** A workspace's stored map, as the chat's `show_map` draws it. */
  stored(org: string): ProjectMap {
    return this.deps.repo.get(org).map;
  }

  /** Whether the map is out of date: it never ran, or tasks merged since it did. */
  async stale(org: string): Promise<{ stale: boolean; merges: number; updatedAt?: string | undefined }> {
    const stored = this.deps.repo.get(org);
    const merges = this.deps.repo.mergesSince(org, stored.updatedAt);
    const hasProjects = (await this.inputs(org)).length > 0;
    return { stale: hasProjects && merges > 0, merges, updatedAt: stored.updatedAt };
  }

  /** What the code pass would read and cost now. Reads each checkout (bounded) and caches the answer for a moment. */
  async estimate(org: string): Promise<MapEstimate> {
    const seen = this.estimates.get(org);
    if (seen !== undefined && this.now().getTime() - seen.at < ESTIMATE_TTL_MS) return seen.value;
    const projects = await this.inputs(org);
    const cap = this.cap();
    const why = await this.codeUnavailable(org, projects.length);
    let value: MapEstimate;
    if (why !== undefined) {
      value = { projects: projects.length, files: 0, tokens: 0, cap, note: why };
    } else {
      const config = await configPass(projects, {
        cache: this.cache,
        ...(this.deps.remotes === undefined ? {} : { remotes: this.deps.remotes }),
      });
      const files = this.unread(org, (await Promise.all(config.loaded.map((l) => selectFiles(l)))).flat());
      const plan = fitBudget(files, await this.deps.price(org), cap);
      value = {
        projects: projects.length,
        files: plan.files.length,
        tokens: plan.tokens,
        ...(plan.usd === undefined ? {} : { usd: plan.usd }),
        cap,
        ...(plan.dropped > 0 ? { note: `${plan.dropped} files left out to stay under the cap.` } : {}),
      };
    }
    this.estimates.set(org, { at: this.now().getTime(), value });
    return value;
  }

  private async codeUnavailable(org: string, projects: number): Promise<string | undefined> {
    if (projects === 0) return "This workspace has no projects on this computer.";
    if (this.deps.ask === undefined) return "No model is set, so the update reads config files only.";
    return this.deps.unavailable(org);
  }

  private progress(org: string, running: Omit<MapRunning, "at"> | undefined): void {
    if (running === undefined) this.running.delete(org);
    else this.running.set(org, { ...running, at: this.now().toISOString() });
    this.deps.changed();
  }

  /**
   * The one action: config pass, history pass, then the code pass within the cost cap. A second call
   * while one runs waits for it and gets the same result. A failed code pass keeps what the first two
   * found and says why in the report; nothing is half saved.
   */
  update(org: string): Promise<MapView> {
    const going = this.updating.get(org);
    if (going !== undefined) return going;
    const run = this.run(org).finally(() => {
      this.updating.delete(org);
      this.progress(org, undefined);
    });
    this.updating.set(org, run);
    return run;
  }

  private async run(org: string): Promise<MapView> {
    const started = this.now().toISOString();
    const projects = await this.inputs(org);
    if (projects.length === 0)
      throw new UserError("This workspace has no projects on this computer to read.", 409);
    this.progress(org, {
      phase: "config",
      text: `Reading config of ${projects.length} ${projects.length === 1 ? "project" : "projects"}…`,
    });
    const config = await configPass(projects, {
      cache: this.cache,
      ...(this.deps.remotes === undefined ? {} : { remotes: this.deps.remotes }),
    });

    const graph = await this.graphPass(org, projects);

    this.progress(org, { phase: "history", text: "Reading what tasks changed together…" });
    const together = this.deps.repo
      .togetherPairs(org, MAP_TOGETHER_MIN)
      .filter((p) => config.nodes.some((n) => n.id === p.a) && config.nodes.some((n) => n.id === p.b));

    const { found, note: codeNote } = await this.codePass(org, config, started);
    const note = [graph?.note, codeNote].filter((n) => n !== undefined).join(" ") || undefined;

    this.progress(org, { phase: "saving", text: "Drawing the map…" });
    const stored = this.deps.repo.get(org);
    const map: ProjectMap = mergeMap(stored.map, {
      config,
      together,
      found,
      graph: graph === undefined ? undefined : { endpoints: graph.endpoints, read: graph.read },
    });
    const before = new Set(stored.map.edges.map((e) => e.id));
    const newLines = map.edges.filter(
      (e) => e.source === "agent" && e.state === "new" && !before.has(e.id),
    ).length;
    const at = this.now().toISOString();
    const report: MapReport = {
      at,
      projects: projects.length,
      fresh: newLines,
      cost: this.deps.spent(usageTask(org), started),
      ...(note === undefined ? {} : { note }),
    };
    this.deps.repo.save(org, map, at, report);
    this.estimates.delete(org);
    return this.view(org);
  }

  /**
   * The graph pass: graphify reads each project in a container with no network and no model, one project
   * at a time, keeping its graph and cache in the project's map folder so the next read is incremental. A
   * project it cannot read is named in the note and keeps what an earlier update found. Never throws.
   */
  private async graphPass(
    org: string,
    projects: readonly ProjectInput[],
  ): Promise<{ endpoints: MapEndpoint[]; read: Set<string>; note?: string } | undefined> {
    const runner = this.deps.graph;
    if (runner === undefined) return undefined;
    const out = { endpoints: [] as MapEndpoint[], read: new Set<string>() };
    const failed: string[] = [];
    let done = 0;
    for (const p of projects) {
      this.progress(org, {
        phase: "graph",
        text: `Reading the code graph of ${p.id} (${done + 1} of ${projects.length})…`,
        done,
        total: projects.length,
      });
      done += 1;
      const run = await runner.extract(org, p.id, p.path);
      if (!run.ok) {
        failed.push(`${p.id}: ${oneLine(run.reason, 120)}`);
        continue;
      }
      const endpoints = await graphEndpoints(run.folder, p.id, new ProjectFiles(p.path));
      if (endpoints === undefined) {
        failed.push(`${p.id}: the reader left no usable result`);
        continue;
      }
      out.endpoints.push(...endpoints);
      out.read.add(p.id);
    }
    return {
      ...out,
      ...(failed.length === 0
        ? {}
        : {
            note: `The code graph could not read ${failed.slice(0, 3).join("; ")}${failed.length > 3 ? ` and ${failed.length - 3} more` : ""}.`,
          }),
    };
  }

  /** The code pass. Never throws: whatever stops it becomes the report's note. */
  private async codePass(
    org: string,
    config: ConfigResult,
    started: string,
  ): Promise<{ found: { endpoints: MapEndpoint[]; reread: Set<string> }; note?: string }> {
    const found = { endpoints: [] as MapEndpoint[], reread: new Set<string>() };
    const why = await this.codeUnavailable(org, config.loaded.length);
    const ask = this.deps.ask;
    if (why !== undefined || ask === undefined) return { found, ...(why === undefined ? {} : { note: why }) };
    const cap = this.cap();
    const all = (await Promise.all(config.loaded.map((l) => selectFiles(l)))).flat();
    const files = this.unread(org, all);
    const plan = fitBudget(files, await this.deps.price(org), cap);
    const byProject = new Map<string, CodeFile[]>();
    for (const f of plan.files) byProject.set(f.project, [...(byProject.get(f.project) ?? []), f]);
    const total = byProject.size;
    let done = 0;
    let note: string | undefined;
    for (const [project, list] of byProject) {
      if (this.deps.spent(usageTask(org), started) >= cap) {
        note = `Stopped at the cost cap of $${cap.toFixed(2)}; ${total - done} ${total - done === 1 ? "project was" : "projects were"} not read.`;
        break;
      }
      this.progress(org, {
        phase: "code",
        text: `Reading code of ${project} (${done + 1} of ${total})…`,
        done,
        total,
      });
      try {
        const { value } = await ask<Proposal>(
          { id: usageTask(org), org },
          proposalPrompt(project, list),
          (reply) => parseProposal(reply, { project, files: list, services: config.services }),
        );
        found.endpoints.push(...value.endpoints);
        found.reread.add(project);
        this.read.set(`${org}|${project}`, hashOf(list));
      } catch (err) {
        note = `The model could not read ${project}: ${oneLine(err instanceof Error ? err.message : String(err), 160)}`;
        break;
      }
      done += 1;
    }
    if (plan.dropped > 0 && note === undefined)
      note = `${plan.dropped} files were left out to stay under the cost cap.`;
    return { found, ...(note === undefined ? {} : { note }) };
  }

  /** The files of projects whose files changed since the model last read them. An unchanged project costs nothing. */
  private unread(org: string, files: readonly CodeFile[]): CodeFile[] {
    const byProject = new Map<string, CodeFile[]>();
    for (const f of files) byProject.set(f.project, [...(byProject.get(f.project) ?? []), f]);
    return [...byProject.entries()]
      .filter(([project, list]) => this.read.get(`${org}|${project}`) !== hashOf(list))
      .flatMap(([, list]) => list);
  }

  /**
   * Starts an update in the background and returns at once with its progress: the page follows it through
   * the \`map\` events and reads the finished map when they say so. A failure shows as \`failed\` on the next read.
   */
  async start(org: string): Promise<MapView> {
    if ((await this.inputs(org)).length === 0) {
      throw new UserError("This workspace has no projects on this computer to read.", 409);
    }
    if (!this.updating.has(org)) {
      this.failed.delete(org);
      this.update(org).catch((err: unknown) => {
        this.failed.set(org, oneLine(err instanceof Error ? err.message : String(err), 200));
        this.deps.changed();
      });
    }
    return this.view(org);
  }

  confirmEdge(org: string, id: string): Promise<MapView> {
    this.deps.repo.change(org, (map) => confirmEdge(map, id));
    this.deps.changed();
    return this.view(org);
  }

  removeEdge(org: string, id: string): Promise<MapView> {
    this.deps.repo.change(org, (map) => removeEdge(map, id));
    this.deps.changed();
    return this.view(org);
  }

  /** The owner says what an address is (or forgets the answer). The lines change at once and stay so on every update. */
  answer(
    org: string,
    address: string,
    scope: string | undefined,
    to: MapAnswer | undefined,
  ): Promise<MapView> {
    const parsed = parseAddress(address);
    if (parsed === undefined) {
      throw new UserError(`"${address}" is not an address. Write a host, or a host and a port.`, 400);
    }
    this.deps.repo.change(org, (map) =>
      answerAddress(
        map,
        { host: parsed.host, port: parsed.port, scope: isLoopbackHost(parsed.host) ? scope : undefined },
        to,
      ),
    );
    this.deps.changed();
    return this.view(org);
  }

  /** The owner sets a project's role, or clears it. */
  setRole(org: string, project: string, role: MapRole | undefined): Promise<MapView> {
    this.deps.repo.change(org, (map) => setRole(map, project, role));
    this.deps.changed();
    return this.view(org);
  }

  /**
   * The slice of the map a task starts with: for each repo of the task, who uses it and what it uses,
   * one line each, confirmed lines only, at most `max` lines. Empty when the workspace has no map.
   */
  briefLines(org: string, repos: readonly string[], max: number): string[] {
    const { map } = this.deps.repo.get(org);
    if (map.edges.length === 0) return [];
    const label = new Map(map.nodes.map((n) => [n.id, n.label]));
    const confirmed = map.edges.filter((e) => e.state === "confirmed" && e.type !== "together");
    const list = (items: string[]) => {
      const shown = items.slice(0, 4);
      const rest = items.length - shown.length;
      const text =
        shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : (shown[0] ?? "");
      return rest > 0 ? `${text} and ${rest} more` : text;
    };
    const lines: string[] = [];
    for (const repo of repos) {
      if (!label.has(repo)) continue;
      const usedBy = confirmed
        .filter((e) => e.to === repo)
        .map((e) => `${oneLine(label.get(e.from) ?? e.from, 40)} (${oneLine(e.label, 50)})`);
      const uses = confirmed
        .filter((e) => e.from === repo)
        .map((e) => `${oneLine(label.get(e.to) ?? e.to, 40)} (${oneLine(e.label, 50)})`);
      if (usedBy.length > 0) lines.push(`${repo} is used by ${list(usedBy)}.`);
      if (uses.length > 0) lines.push(`${repo} uses ${list(uses)}.`);
    }
    return lines.slice(0, max);
  }
}
