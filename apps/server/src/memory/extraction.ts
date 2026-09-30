import type { MemoryExtractOutput, RoomItem, Task } from "@majhi/shared";
import { errorMessage, UserError } from "../errors.ts";
import type { CurationTask, Curator } from "./curator.ts";
import { type Housekeeper, NoHousekeeper, roomText } from "./housekeeper.ts";

export interface ExtractionDeps {
  housekeeper: Housekeeper;
  curator: Curator;
  task: (id: string) => Task | undefined;
  /** The task's room items, newest page. */
  room: (task: string) => RoomItem[];
  /** A line in the task's room. */
  say: (task: string, level: "info" | "warn", text: string) => void;
}

/** What the curator needs to know of a task. */
export function curationTask(task: Task): CurationTask {
  return { id: task.id, org: task.org, projects: task.repos.map((r) => r.project) };
}

/** After a task: the Housekeeper reads its room, and what it writes goes through curation. */
export class Extraction {
  private readonly running = new Set<string>();

  constructor(private readonly deps: ExtractionDeps) {}

  /** For the command: the counts, or an error that says why nothing was read. */
  async extract(id: string): Promise<MemoryExtractOutput> {
    try {
      return await this.read(id);
    } catch (err) {
      // The owner asked: say why nothing was read, whatever went wrong.
      throw err instanceof UserError ? err : new UserError(errorMessage(err), 409);
    }
  }

  private async read(id: string): Promise<MemoryExtractOutput> {
    const task = this.deps.task(id);
    if (task === undefined) throw new UserError(`Task ${id} does not exist.`, 404);
    if (this.running.has(id)) throw new UserError(`The Housekeeper is already reading ${id}.`, 409);
    this.running.add(id);
    try {
      const curation = curationTask(task);
      const { facts, agent } = await this.deps.housekeeper.extract(
        curation,
        roomText(task, this.deps.room(id)),
      );
      const counts = await this.deps.curator.curateCandidates(curation, facts, agent);
      this.report(id, counts);
      return counts;
    } finally {
      this.running.delete(id);
    }
  }

  /**
   * A task became done. Starts reading its room and returns at once; it never fails the close. A
   * missing Housekeeper is not said (nobody asked for one); any other problem is said in the room.
   */
  afterClose(task: Task): void {
    void this.read(task.id).catch((err: unknown) => {
      if (err instanceof NoHousekeeper) return;
      this.say(task.id, "warn", `Memory was not extracted: ${errorMessage(err)}`);
    });
  }

  private report(id: string, c: MemoryExtractOutput): void {
    if (c.candidates === 0) return;
    const parts = [
      c.kept > 0 ? `${c.kept} kept` : undefined,
      c.dropped > 0 ? `${c.dropped} dropped` : undefined,
      c.duplicates > 0 ? `${c.duplicates} already known` : undefined,
      c.rejected > 0 ? `${c.rejected} rejected for holding a secret or personal data` : undefined,
      c.pending > 0 ? `${c.pending} waiting for your review` : undefined,
    ].filter((p) => p !== undefined);
    this.say(
      id,
      "info",
      `Memory: the Housekeeper wrote ${c.candidates} fact${c.candidates === 1 ? "" : "s"}: ${parts.join(", ")}. See the Memory tab.`,
    );
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
