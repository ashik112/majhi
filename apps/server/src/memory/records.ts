import type {
  MemoryScope,
  ProjectBrief,
  RecordRepo,
  TaskRecord,
  TaskRecordHit,
  Thread,
  ThreadStatus,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import { applyPatch } from "./brief-doc.ts";
import type { RecordStore } from "./record-store.ts";
import { CANDIDATES, fuse } from "./search.ts";

export interface ProjectMemoryDeps {
  store: RecordStore;
  /** Unit vectors, or undefined when the model is not there. */
  embed: (texts: readonly string[]) => Promise<Float32Array[] | undefined>;
  now?: () => Date;
  /** Something changed: the UI refreshes. */
  onChange?: () => void;
}

export interface RecordInput {
  task: string;
  title: string;
  org?: string | undefined;
  projects: readonly string[];
  asked: string;
  done: string;
  decisions: string;
  outcome: string;
  left: string;
  repos: readonly RecordRepo[];
  agent?: string | undefined;
}

/** The scopes a record of a task is seen in: its org and its projects. Never global. */
export function recordScopes(org: string | undefined, projects: readonly string[]): MemoryScope[] {
  return [...(org === undefined ? [] : [`org:${org}`]), ...projects.map((p) => `project:${p}`)];
}

/** What a record is found by in meaning: its title and first sections. */
function embedText(r: Pick<TaskRecord, "title" | "asked" | "done">): string {
  return `${r.title}\n${r.asked}\n${r.done}`.slice(0, 2_000);
}

/**
 * Task records, project briefs and open threads: what finished tasks did, where each project
 * stands, and what is still open. Records and briefs are written by the Housekeeper without
 * approval; every brief version is kept; threads close by a later record, by their follow-up
 * task, or by hand.
 */
export class ProjectMemory {
  private readonly store: RecordStore;
  private readonly now: () => Date;

  constructor(private readonly deps: ProjectMemoryDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------------------
  // Records

  /** Writes the task's record, or writes it again. Returns it and whether it is new. */
  async putRecord(input: RecordInput): Promise<{ record: TaskRecord; created: boolean }> {
    const result = this.store.putRecord({
      ...input,
      scopes: recordScopes(input.org, input.projects),
      at: this.at(),
    });
    const [vector] = (await this.deps.embed([embedText(result.record)])) ?? [];
    if (vector !== undefined) this.store.setRecordVector(result.record.id, vector);
    this.changed();
    return result;
  }

  record(task: string): TaskRecord | undefined {
    return this.store.record(task);
  }

  /**
   * Records seen in `scopes` (undefined: all). With a query: the best by keywords and meaning, fused
   * by reciprocal rank. Without: newest first.
   */
  async records(options: {
    query?: string | undefined;
    scopes?: readonly MemoryScope[] | undefined;
    project?: string | undefined;
    except?: string | undefined;
    limit: number;
  }): Promise<TaskRecordHit[]> {
    const { scopes, project } = options;
    const keep = (r: TaskRecord) => r.task !== options.except;
    const query = options.query?.trim() ?? "";
    if (query === "") {
      return this.store
        .records({ scopes, project, limit: options.limit + 1 })
        .filter(keep)
        .slice(0, options.limit)
        .map((record) => ({ record, score: 0 }));
    }
    if (this.store.countRecords(scopes, project) === 0) return [];
    await this.fillVectors();
    const keyword = this.store.recordKeywordIds(query, scopes, project, CANDIDATES);
    const [vector] = (await this.deps.embed([query])) ?? [];
    const nearest =
      vector === undefined ? [] : this.store.recordNearestIds(vector, scopes, project, CANDIDATES);
    const scores = fuse([keyword, nearest]);
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const records = this.store.recordsByIds(ranked.map(([id]) => id));
    const score = new Map(ranked);
    return records
      .filter(keep)
      .slice(0, options.limit)
      .map((record) => ({ record, score: score.get(record.id) ?? 0 }));
  }

  private async fillVectors(): Promise<void> {
    const missing = this.store.recordsWithoutVector(16);
    if (missing.length === 0) return;
    const vectors = await this.deps.embed(missing.map(embedText));
    if (vectors === undefined) return;
    missing.forEach((r, i) => {
      const v = vectors[i];
      if (v !== undefined) this.store.setRecordVector(r.id, v);
    });
  }

  // ---------------------------------------------------------------------------
  // Briefs

  brief(project: string): { current?: ProjectBrief; versions: ProjectBrief[] } {
    const versions = this.store.briefs(project);
    const [current] = versions;
    return current === undefined ? { versions } : { current, versions };
  }

  currentBrief(project: string): ProjectBrief | undefined {
    return this.store.brief(project);
  }

  /**
   * Applies a patch (sections to replace) from a task's record. A new version when it changes
   * something; undefined when it does not.
   */
  patchBrief(
    project: string,
    patch: Readonly<Record<string, string>>,
    from: { task: string; agent?: string | undefined },
  ): ProjectBrief | undefined {
    const current = this.store.brief(project);
    const body = applyPatch(current?.body, patch);
    if (body === undefined) return undefined;
    const brief = this.store.addBrief({
      project,
      body,
      source: current === undefined ? "built" : "task",
      task: from.task,
      agent: from.agent,
      at: this.at(),
    });
    this.changed();
    return brief;
  }

  /** A whole brief, built from the repo docs and the records. A new version. */
  setBrief(
    project: string,
    sections: Readonly<Record<string, string>>,
    agent: string | undefined,
  ): ProjectBrief {
    const body = applyPatch(undefined, sections);
    if (body === undefined) throw new UserError("The Housekeeper wrote an empty brief.", 409);
    const brief = this.store.addBrief({
      project,
      body,
      source: "built",
      agent,
      at: this.at(),
    });
    this.changed();
    return brief;
  }

  /** Puts an older version back as the newest. Nothing is lost: the version it replaces stays. */
  restoreBrief(project: string, version: number): ProjectBrief {
    const old = this.store.brief(project, version);
    if (old === undefined) throw new UserError(`${project} has no brief version ${version}.`, 404);
    const current = this.store.brief(project);
    if (current !== undefined && current.version === version) {
      throw new UserError(`Version ${version} is already the brief of ${project}.`, 409);
    }
    const brief = this.store.addBrief({
      project,
      body: old.body,
      source: "restored",
      restoredFrom: version,
      at: this.at(),
    });
    this.changed();
    return brief;
  }

  // ---------------------------------------------------------------------------
  // Threads

  openThread(input: {
    text: string;
    project?: string | undefined;
    org?: string | undefined;
    task: string;
    followUp?: string | undefined;
  }): Thread {
    const thread = this.store.addThread({ ...input, at: this.at() });
    this.changed();
    return thread;
  }

  thread(id: number): Thread | undefined {
    return this.store.thread(id);
  }

  threads(filter: {
    projects?: readonly string[] | undefined;
    status?: ThreadStatus | undefined;
    task?: string | undefined;
    limit?: number | undefined;
  }): Thread[] {
    return this.store.threads(filter);
  }

  /** Closes an open thread. `by` is `owner`, `task:<id>` or `follow-up:<id>`. */
  closeThread(id: number, by: string, reason?: string): Thread {
    const thread = this.mustThread(id);
    if (thread.status === "closed") throw new UserError(`Thread ${id} is already closed.`, 409);
    this.store.closeThread(id, by, reason, this.at());
    this.changed();
    return this.mustThread(id);
  }

  reopenThread(id: number): Thread {
    const thread = this.mustThread(id);
    if (thread.status === "open") throw new UserError(`Thread ${id} is already open.`, 409);
    this.store.reopenThread(id);
    this.changed();
    return this.mustThread(id);
  }

  /** A task is done: the open threads it was made to do close. Resolves how many. */
  closeFollowUps(task: string): number {
    const open = this.store.threads({ followUp: task, status: "open" });
    for (const t of open) this.store.closeThread(t.id, `follow-up:${task}`, `${task} is done.`, this.at());
    if (open.length > 0) this.changed();
    return open.length;
  }

  /** Before a task's record is written again: the open threads it opened go, to be written again. */
  dropOpenThreadsOf(task: string): void {
    if (this.store.dropOpenThreadsOf(task) > 0) this.changed();
  }

  // ---------------------------------------------------------------------------
  // TASK.md

  taskMemory(task: string): string | undefined {
    return this.store.taskMemory(task);
  }

  setTaskMemory(task: string, text: string): void {
    this.store.setTaskMemory(task, text, this.at());
  }

  /** A one-time step's note, if it ran. */
  meta(key: string): string | undefined {
    return this.store.meta(key);
  }

  setMeta(key: string, value: string): void {
    this.store.setMeta(key, value);
  }

  private mustThread(id: number): Thread {
    const thread = this.store.thread(id);
    if (thread === undefined) throw new UserError(`There is no thread ${id}.`, 404);
    return thread;
  }

  private changed(): void {
    try {
      this.deps.onChange?.();
    } catch {
      // A listener's problem is not memory's.
    }
  }

  private at(): string {
    return this.now().toISOString();
  }
}
