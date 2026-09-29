import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentLive, RoomItem, RoomServerMessage, Task, TaskId } from "@majhi/shared";
import { z } from "zod";
import type { RoomPayload, Store } from "../store/index.ts";

/** How many items a new socket gets. */
export const SNAPSHOT_ITEMS = 200;
/** Streamed text is written and sent at most this often per task. */
export const FLUSH_MS = 50;

export type RoomListener = (message: RoomServerMessage) => void;

/**
 * The room of every task: stores items, tells the sockets watching a task, and holds
 * each agent's live state. Streaming items (agent text, thoughts) are held for a moment and
 * written together, so a fast stream costs a few writes a second, not one per chunk.
 */

const CommandsFileSchema = z.record(
  z.string(),
  z.array(z.object({ name: z.string(), description: z.string().optional() })),
);

export class RoomService {
  private readonly listeners = new Map<string, Set<RoomListener>>();
  private readonly live = new Map<string, Map<string, AgentLive>>();
  private readonly deferred = new Map<string, Map<string, RoomPayload>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  /** The last slash commands each agent advertised, so `/` works before a session starts. */
  private readonly commands = new Map<string, AgentLive["commands"]>();

  constructor(
    private readonly store: Store,
    /** Where the command lists survive restarts. Absent in tests. */
    private readonly commandsFile?: string,
  ) {
    if (commandsFile === undefined) return;
    try {
      const saved = CommandsFileSchema.parse(JSON.parse(readFileSync(commandsFile, "utf8")));
      for (const [agent, list] of Object.entries(saved)) this.commands.set(agent, list);
    } catch {
      // No file yet, or an unreadable one: start empty.
    }
  }

  knownCommands(agent: string): AgentLive["commands"] {
    return this.commands.get(agent) ?? [];
  }

  rememberCommands(agent: string, list: AgentLive["commands"]): void {
    this.commands.set(agent, list);
    if (this.commandsFile === undefined) return;
    const file = this.commandsFile;
    void mkdir(dirname(file), { recursive: true })
      .then(() => writeFile(file, JSON.stringify(Object.fromEntries(this.commands))))
      .catch(() => undefined);
  }

  /**
   * Stores an item and sends it to the task's sockets. With `defer`, waits up to 50 ms and
   * merges with later writes of the same id. Any other write to the task sends held items first,
   * so order is kept.
   */
  post(task: TaskId, id: string, payload: RoomPayload, options: { defer?: boolean } = {}): void {
    if (options.defer === true) {
      const held = this.deferred.get(task) ?? new Map<string, RoomPayload>();
      held.set(id, payload);
      this.deferred.set(task, held);
      if (!this.timers.has(task)) {
        const timer = setTimeout(() => this.flush(task), FLUSH_MS);
        timer.unref();
        this.timers.set(task, timer);
      }
      return;
    }
    this.flush(task);
    this.write(task, id, payload);
  }

  /** Writes and sends everything held for the task. */
  flush(task: string): void {
    const timer = this.timers.get(task);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(task);
    const held = this.deferred.get(task);
    if (held === undefined) return;
    this.deferred.delete(task);
    for (const [id, payload] of held) this.write(task as TaskId, id, payload);
  }

  private write(task: TaskId, id: string, payload: RoomPayload): RoomItem {
    const item = this.store.room.upsert(task, id, payload);
    this.send(task, { type: "item", item });
    return item;
  }

  /** The stored item, with anything still held for it merged in. */
  get(task: string, id: string): RoomItem | undefined {
    this.flush(task);
    return this.store.room.get(task, id);
  }

  setLive(task: TaskId, live: AgentLive): void {
    const agents = this.live.get(task) ?? new Map<string, AgentLive>();
    agents.set(live.agent, live);
    this.live.set(task, agents);
    this.send(task, { type: "agent", agent: live });
  }

  getLive(task: string, agent: string): AgentLive | undefined {
    return this.live.get(task)?.get(agent);
  }

  /** Agents of the task that have live state. */
  liveAgents(task: string): AgentLive[] {
    return [...(this.live.get(task)?.values() ?? [])];
  }

  /** Tells the sockets watching the task that the task itself changed. */
  publishTask(task: Task): void {
    this.send(task.id, { type: "task", task });
  }

  /** The last 200 items in the order they appeared, and every team agent's state. */
  snapshot(task: Task): Extract<RoomServerMessage, { type: "snapshot" }> {
    this.flush(task.id);
    const page = this.store.room.page(task.id, SNAPSHOT_ITEMS);
    const items = [...page.items].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const agents = task.team.map(
      (id): AgentLive =>
        this.getLive(task.id, id) ?? {
          agent: id,
          status: "stopped",
          queued: this.store.room.queuedFor(task.id, id).length,
          commands: this.knownCommands(id),
        },
    );
    return { type: "snapshot", items, agents, more: page.more };
  }

  subscribe(task: string, listener: RoomListener): () => void {
    const set = this.listeners.get(task) ?? new Set<RoomListener>();
    set.add(listener);
    this.listeners.set(task, set);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(task) === set) this.listeners.delete(task);
    };
  }

  /** Forgets everything in memory about a task that was removed. */
  drop(task: string): void {
    const timer = this.timers.get(task);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(task);
    this.deferred.delete(task);
    this.live.delete(task);
  }

  private send(task: string, message: RoomServerMessage): void {
    for (const listener of this.listeners.get(task) ?? []) listener(message);
  }
}
