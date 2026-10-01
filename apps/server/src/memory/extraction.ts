import type { MemoryExtractOutput, ProjectBrief, RoomItem, Task, TaskRepo } from "@majhi/shared";
import { errorMessage, UserError } from "../errors.ts";
import { firstWords } from "./brief-doc.ts";
import { type CurationTask, type Curator, EMPTY_COUNTS } from "./curator.ts";
import {
  agentSpoke,
  briefPrompt,
  chatLines,
  chatPrompt,
  type Housekeeper,
  NoHousekeeper,
  parseBriefReply,
  parseChatReply,
  parseRecordReply,
  type RecordReply,
  recordPrompt,
  roomSources,
  sourceTask,
} from "./housekeeper.ts";
import { compactRecord } from "./recall.ts";
import { headings, OVERVIEW_DOCS, type RepoDocs, readRepoFile } from "./repo-docs.ts";
import type { MemoryService } from "./service.ts";
import { factsText, type RepoFacts, repoFacts } from "./task-git.ts";

/** The repo docs a lesson must not restate, as prompt text. */
const RULES_CHARS = 6_000;
const OVERVIEW_CHARS = 5_000;
const README_START = 1_500;

export interface ExtractionDeps {
  housekeeper: Housekeeper;
  curator: Curator;
  memory: MemoryService;
  repoDocs: RepoDocs;
  task: (id: string) => Task | undefined;
  /** The task's room items, newest page. */
  room: (task: string) => RoomItem[];
  /** Tasks made from this one (follow-ups and children), one line each with their id first. */
  madeFrom: (task: string) => { id: string; title: string; status: string }[];
  /** A project's own checkout and its org. */
  project: (id: string) => Promise<{ path: string; org: string } | undefined>;
  /** A line in the task's room. */
  say: (task: string, level: "info" | "warn", text: string) => void;
  /** Reads git for one repo. Tests may replace it. */
  repoFacts?: (repo: TaskRepo, createdAt: string) => Promise<RepoFacts>;
}

/** What the curator needs to know of a task. */
export function curationTask(task: Task): CurationTask {
  return { id: task.id, org: task.org, projects: task.repos.map((r) => r.project) };
}

/**
 * After a task: the Housekeeper reads what happened (the room, the branch's commits and diff stat,
 * the docs it changed) and writes the task's record, the threads it left open and those it closed,
 * a patch to each project's brief, and at most three lessons, which go through curation. One
 * session per task, its tokens recorded under the task.
 */
export class Extraction {
  private readonly running = new Set<string>();

  constructor(private readonly deps: ExtractionDeps) {}

  /** For the command: writes the record again, whatever was there. An error says why nothing was read. */
  async extract(id: string): Promise<MemoryExtractOutput> {
    try {
      return await this.read(id, { again: true });
    } catch (err) {
      // The owner asked: say why nothing was read, whatever went wrong.
      throw err instanceof UserError ? err : new UserError(errorMessage(err), 409);
    }
  }

  /**
   * A task became done. Closes the threads it was made for, then starts reading it and returns at
   * once; it never fails the close. A task with a record already, or where no agent wrote, is
   * skipped. A missing Housekeeper is not said (nobody asked for one); any other problem is said
   * in the room. `memory.extract` still reads any task.
   */
  afterClose(task: Task): void {
    try {
      this.deps.memory.project.closeFollowUps(task.id);
    } catch (err) {
      console.error(`Closing the threads of ${task.id} failed: ${errorMessage(err)}`);
    }
    if (this.running.has(task.id) || this.deps.memory.project.record(task.id) !== undefined) return;
    // No agent wrote anything (a promotion task, a task closed without a run): nothing to record, no tokens spent.
    if (!agentSpoke(this.deps.room(task.id))) return;
    void this.read(task.id, { again: false }).catch((err: unknown) => {
      if (err instanceof NoHousekeeper) return;
      this.say(task.id, "warn", `Memory was not written: ${errorMessage(err)}`);
    });
  }

  private async read(id: string, options: { again: boolean }): Promise<MemoryExtractOutput> {
    const { deps } = this;
    const project = deps.memory.project;
    const task = deps.task(id);
    if (task === undefined) throw new UserError(`Task ${id} does not exist.`, 404);
    if (this.running.has(id)) throw new UserError(`The Housekeeper is already reading ${id}.`, 409);
    this.running.add(id);
    try {
      if (!options.again && project.record(id) !== undefined) return { ...EMPTY_COUNTS };
      const curation = curationTask(task);
      const projects = curation.projects;
      const paths = (await Promise.all(projects.map((p) => deps.project(p)))).flatMap((p) =>
        p === undefined ? [] : [p.path],
      );
      const read = deps.repoFacts ?? repoFacts;
      const facts = await Promise.all(task.repos.map((r) => read(r, task.createdAt)));
      const { handbacks, room } = roomSources(deps.room(id));
      const threads = project.threads({ projects, status: "open", limit: 60 });
      const briefs = await Promise.all(
        projects.map(async (p) => {
          const current = project.currentBrief(p);
          if (current !== undefined) return { project: p, body: current.body };
          const path = (await deps.project(p))?.path;
          return { project: p, overview: path === undefined ? "" : await overview(path) };
        }),
      );
      const madeFrom = deps.madeFrom(id);
      const prompt = recordPrompt({
        task: sourceTask(task, curation),
        handbacks,
        room,
        git: factsText(facts),
        followUps: madeFrom.map((t) => `${t.id}: ${t.title} (${t.status})`),
        threads,
        briefs,
        rules: await deps.repoDocs.text(paths, RULES_CHARS),
      });
      const { value: reply, agent } = await deps.housekeeper.ask(task, prompt, parseRecordReply);

      // The task is still there and still done? A record is written whatever its status now.
      await project.putRecord({
        task: id,
        title: task.title,
        org: task.org,
        projects,
        ...reply.record,
        repos: facts.map((f) => f.repo),
        agent,
      });
      const counts: MemoryExtractOutput = { ...EMPTY_COUNTS, record: true };
      if (options.again) project.dropOpenThreadsOf(id);
      counts.threads_opened = this.openThreads(
        task,
        reply,
        madeFrom.map((t) => t.id),
      );
      counts.threads_closed = this.closeThreads(task, reply);
      counts.briefs = this.patchBriefs(task, reply, agent);
      const lessons = await deps.curator.curateCandidates(curation, reply.lessons, agent);
      const out = { ...lessons, ...pick(counts) };
      deps.memory.changed();
      this.report(id, out);
      return out;
    } finally {
      this.running.delete(id);
    }
  }

  /** Each Left item as an open thread, in one of the task's projects. Resolves how many. */
  private openThreads(task: Task, reply: RecordReply, madeFrom: readonly string[]): number {
    const projects = task.repos.map((r) => r.project);
    let n = 0;
    for (const t of reply.threads) {
      const project = t.project !== undefined && projects.includes(t.project) ? t.project : projects[0];
      // Only a task made from this one counts as its follow-up: an id the model made up does not.
      const followUp = t.follow_up !== undefined && madeFrom.includes(t.follow_up) ? t.follow_up : undefined;
      this.deps.memory.project.openThread({ text: t.text, project, org: task.org, task: task.id, followUp });
      n += 1;
    }
    return n;
  }

  /** The open threads the record says were done, in the task's own projects only. */
  private closeThreads(task: Task, reply: RecordReply): number {
    const projects = task.repos.map((r) => r.project);
    let n = 0;
    for (const id of new Set(reply.closes)) {
      const thread = this.deps.memory.project.thread(id);
      if (thread === undefined || thread.status !== "open" || thread.task === task.id) continue;
      if (thread.project === undefined || !projects.includes(thread.project)) continue;
      this.deps.memory.project.closeThread(id, `task:${task.id}`, `Done in ${task.id}.`);
      n += 1;
    }
    return n;
  }

  /** Applies the brief patches to the task's own projects. Resolves the projects that got a new version. */
  private patchBriefs(task: Task, reply: RecordReply, agent: string): string[] {
    const changed: string[] = [];
    for (const p of task.repos.map((r) => r.project)) {
      const patch = reply.brief[p];
      if (patch === undefined) continue;
      if (this.deps.memory.project.patchBrief(p, patch, { task: task.id, agent }) !== undefined)
        changed.push(p);
    }
    return changed;
  }

  /**
   * Reads a stretch of a chat and sends its facts through curation, like a task's lessons. The
   * facts are scoped to the chat's org (a root chat: global) and to the projects named in it,
   * never to another org. `onRead` runs once the Housekeeper has answered and before anything is
   * written, so the caller moves its watermark exactly once: a failure before it leaves the
   * messages for the next try, a crash after it never reads them again.
   */
  async fromChat(
    task: Task,
    items: readonly RoomItem[],
    projects: readonly string[],
    onRead: () => void,
  ): Promise<MemoryExtractOutput> {
    const chat = {
      id: task.id,
      org: task.org,
      projects: task.org === undefined ? [] : projects,
      title: task.title,
      agent: task.team[0] ?? "agent",
    };
    const { value, agent } = await this.deps.housekeeper.ask(
      task,
      chatPrompt({ chat, messages: chatLines(items) }),
      parseChatReply,
    );
    onRead();
    const counts = await this.deps.curator.curateCandidates(chat, value, agent);
    this.deps.memory.changed();
    return counts;
  }

  /**
   * Writes a project's brief from its docs and its task records, as a new version. For the owner's
   * "Build it now"; tokens are recorded under the project's latest task, if it has one.
   */
  async buildBrief(projectId: string): Promise<ProjectBrief> {
    const { deps } = this;
    const project = await deps.project(projectId);
    if (project === undefined) throw new UserError(`There is no project ${projectId}.`, 404);
    const records = (await deps.memory.project.records({ project: projectId, limit: 12 })).map(
      (h) => h.record,
    );
    const current = deps.memory.project.currentBrief(projectId);
    try {
      const { value, agent } = await deps.housekeeper.ask(
        { id: records[0]?.task ?? `brief:${projectId}`, org: project.org },
        briefPrompt({
          project: projectId,
          overview: await overview(project.path),
          records: records.map((r) => compactRecord(r, 900)).join("\n\n"),
          current: current?.body,
        }),
        parseBriefReply,
      );
      return deps.memory.project.setBrief(projectId, value, agent);
    } catch (err) {
      if (err instanceof UserError) throw err;
      throw new UserError(errorMessage(err), 409);
    }
  }

  private report(id: string, c: MemoryExtractOutput): void {
    const parts = [
      c.record ? "wrote the task record" : undefined,
      c.briefs.length > 0 ? `updated the brief of ${c.briefs.join(", ")}` : undefined,
      c.threads_opened > 0
        ? `${c.threads_opened} open thread${c.threads_opened === 1 ? "" : "s"}`
        : undefined,
      c.threads_closed > 0
        ? `closed ${c.threads_closed} older thread${c.threads_closed === 1 ? "" : "s"}`
        : undefined,
      c.kept > 0 ? `${c.kept} lesson${c.kept === 1 ? "" : "s"} kept` : undefined,
      c.pending > 0 ? `${c.pending} lesson${c.pending === 1 ? "" : "s"} waiting for your review` : undefined,
    ].filter((p) => p !== undefined);
    if (parts.length === 0) return;
    this.say(id, "info", `Memory: ${parts.join(", ")}. See the Memory tab.`);
  }

  /** A line in the room. The room may be gone (shutdown): then nobody is left to tell. */
  private say(id: string, level: "info" | "warn", text: string): void {
    try {
      this.deps.say(id, level, text);
    } catch {
      // Nothing to do.
    }
  }
}

function pick(c: MemoryExtractOutput) {
  return {
    record: c.record,
    threads_opened: c.threads_opened,
    threads_closed: c.threads_closed,
    briefs: c.briefs,
  };
}

/** What a project's docs say it is: the start of its README and the headings of its main docs. */
export async function overview(repo: string): Promise<string> {
  const parts: string[] = [];
  const readme = await readRepoFile(repo, "README.md");
  if (readme !== undefined)
    parts.push(`--- README.md (start) ---\n${firstWords(readme.slice(0, README_START), 250)}`);
  for (const file of OVERVIEW_DOCS) {
    const text = await readRepoFile(repo, file);
    if (text === undefined) continue;
    const outline = headings(text);
    if (outline.length > 0) parts.push(`--- ${file} (headings) ---\n${outline.join("\n")}`);
  }
  const all = parts.join("\n\n");
  return all.length > OVERVIEW_CHARS ? `${all.slice(0, OVERVIEW_CHARS)}\n[cut]` : all;
}
