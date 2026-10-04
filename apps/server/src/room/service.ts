import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentLive, ProcessInfo, RoomItem, RoomServerMessage, Task, TaskId } from "@majhi/shared";
import { z } from "zod";
import { redactDeep } from "../connections/redact.ts";
import type { RoomPayload, Store } from "../store/index.ts";

/** How many items a new socket gets. */
export const SNAPSHOT_ITEMS = 200;
/** Streamed text is sent to the sockets, as the new part only, at most this often per task. */
export const FLUSH_MS = 50;
/** A streamed message is stored at most this often while it grows, and once more when it ends. */
export const SAVE_MS = 1000;
/** A streamed message nobody wrote to for this long is forgotten. */
const STREAM_IDLE_MS = 60_000;

/** A streamed message the sockets have seen: what they hold and whether the store has the same. */
interface Stream {
  /** The text every socket holds (redacted). */
  sent: string;
  /** Everything but the text, to notice a change that a text delta cannot carry. */
  shape: string;
  payload: RoomPayload;
  /** True while the store holds less than the sockets saw. */
  dirty: boolean;
  savedAt: number;
  touchedAt: number;
}

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
  private redact: ((task: string, text: string) => string) | undefined;
  private readonly listeners = new Map<string, Set<RoomListener>>();
  private readonly live = new Map<string, Map<string, AgentLive>>();
  /** Each task's background processes, as the process manager last reported them. */
  private readonly processes = new Map<string, ProcessInfo[]>();
  private readonly deferred = new Map<string, Map<string, RoomPayload>>();
  /** Streamed messages by task and item id: what the sockets hold, so only the new text is sent. */
  private readonly streams = new Map<string, Map<string, Stream>>();
  private readonly saveTimers = new Map<string, NodeJS.Timeout>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly writeListeners = new Set<(task: TaskId, item: RoomItem) => void>();

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

  /** Moves the remembered slash commands of a renamed agent to its new handle. */
  renameCommands(agent: string, newAgent: string): void {
    const list = this.commands.get(agent);
    if (list === undefined) return;
    this.commands.delete(agent);
    this.rememberCommands(newAgent, list);
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
   * Stores an item and sends it to the task's sockets. With `defer` (streamed text), waits up to
   * 50 ms and merges with later writes of the same id, then sends only the text that is new and
   * stores the item about once a second. Any other write to the task sends and stores held items
   * first, so order is kept.
   */
  post(task: TaskId, id: string, payload: RoomPayload, options: { defer?: boolean } = {}): void {
    if (options.defer === true) {
      const held = this.deferred.get(task) ?? new Map<string, RoomPayload>();
      held.set(id, payload);
      this.deferred.set(task, held);
      if (!this.timers.has(task)) {
        const timer = setTimeout(() => this.tick(task), FLUSH_MS);
        timer.unref();
        this.timers.set(task, timer);
      }
      return;
    }
    this.flush(task);
    this.write(task, id, payload);
  }

  /** The 50 ms beat of a stream: sends what is held, stores what is due. */
  private tick(task: string): void {
    this.timers.delete(task);
    const held = this.deferred.get(task);
    this.deferred.delete(task);
    const now = Date.now();
    for (const [id, payload] of held ?? []) this.stream(task as TaskId, id, payload, now);
    const streams = this.streams.get(task);
    if (streams === undefined) return;
    let waiting = false;
    for (const [id, s] of streams) {
      if (s.dirty && now - s.savedAt >= SAVE_MS) this.save(task as TaskId, id, s, now);
      if (s.dirty) waiting = true;
      else if (now - s.touchedAt > STREAM_IDLE_MS) streams.delete(id);
    }
    if (streams.size === 0) this.streams.delete(task);
    if (waiting && !this.saveTimers.has(task)) {
      const timer = setTimeout(() => {
        this.saveTimers.delete(task);
        this.tick(task);
      }, SAVE_MS);
      timer.unref();
      this.saveTimers.set(task, timer);
    }
  }

  /** Writes and sends everything held for the task, and stores streamed text the store has not seen yet. */
  flush(task: string): void {
    const timer = this.timers.get(task);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(task);
    const saveTimer = this.saveTimers.get(task);
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    this.saveTimers.delete(task);
    const held = this.deferred.get(task);
    this.deferred.delete(task);
    const now = Date.now();
    for (const [id, payload] of held ?? []) this.stream(task as TaskId, id, payload, now);
    for (const [id, s] of this.streams.get(task) ?? []) {
      if (!s.dirty) continue;
      // The sockets saw the text as deltas: the stored item, whole, makes sure they end up with the same.
      const item = this.save(task as TaskId, id, s, now);
      this.send(task, { type: "item", item });
    }
  }

  /** A streamed item: the first write goes out whole, later ones as the text that was added. */
  private stream(task: TaskId, id: string, payload: RoomPayload, now: number): void {
    const redact = this.redact;
    const clean = redact === undefined ? payload : redactDeep(payload, (text) => redact(task, text));
    const text = "text" in clean && typeof clean.text === "string" ? clean.text : undefined;
    const streams = this.streams.get(task) ?? new Map<string, Stream>();
    this.streams.set(task, streams);
    const before = streams.get(id);
    if (text === undefined) {
      streams.delete(id);
      const item = this.store.room.upsert(task, id, clean);
      this.send(task, { type: "item", item });
      this.listen(task, item);
      return;
    }
    const shape = JSON.stringify({ ...clean, text: "" });
    if (before === undefined || shape !== before.shape || !text.startsWith(before.sent)) {
      // New, or changed in a way a delta cannot say (an earlier part redacted, media added).
      const item = this.store.room.upsert(task, id, clean);
      streams.set(id, { sent: text, shape, payload: clean, dirty: false, savedAt: now, touchedAt: now });
      this.send(task, { type: "item", item });
      this.listen(task, item);
      return;
    }
    if (text.length > before.sent.length) {
      this.send(task, { type: "delta", id, offset: before.sent.length, append: text.slice(before.sent.length) });
      before.sent = text;
      before.payload = clean;
      before.dirty = true;
    }
    before.touchedAt = now;
  }

  private save(task: TaskId, id: string, s: Stream, now: number): RoomItem {
    const item = this.store.room.upsert(task, id, s.payload);
    s.dirty = false;
    s.savedAt = now;
    this.listen(task, item);
    return item;
  }

  private listen(task: TaskId, item: RoomItem): void {
    for (const listener of this.writeListeners) {
      try {
        listener(task, item);
      } catch {
        // A listener that fails must not lose the item.
      }
    }
  }

  /**
   * Replaces what must not be stored or shown, like the secret values a task's runs hold (5.14).
   * Applied to every item written and to each agent's "now doing" line.
   */
  redactWith(redact: (task: string, text: string) => string): void {
    this.redact = redact;
  }

  private write(task: TaskId, id: string, payload: RoomPayload): RoomItem {
    const redact = this.redact;
    const clean = redact === undefined ? payload : redactDeep(payload, (text) => redact(task, text));
    const item = this.store.room.upsert(task, id, clean);
    this.send(task, { type: "item", item });
    this.listen(task, item);
    return item;
  }

  /** Calls `listener` after every stored item, from any task. */
  onWrite(listener: (task: TaskId, item: RoomItem) => void): void {
    this.writeListeners.add(listener);
  }

  /** The stored item, with anything still held for it merged in. */
  get(task: string, id: string): RoomItem | undefined {
    this.flush(task);
    return this.store.room.get(task, id);
  }

  setLive(task: TaskId, given: AgentLive): void {
    const redact = this.redact;
    const live =
      redact === undefined || given.nowDoing === undefined
        ? given
        : { ...given, nowDoing: redact(task, given.nowDoing) };
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

  /** The task's processes changed (5.15). */
  setProcesses(task: string, processes: ProcessInfo[]): void {
    this.processes.set(task, processes);
    this.send(task, { type: "processes", processes });
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
    return { type: "snapshot", items, agents, more: page.more, processes: this.processes.get(task.id) ?? [] };
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
    this.streams.delete(task);
    const saveTimer = this.saveTimers.get(task);
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    this.saveTimers.delete(task);
    this.live.delete(task);
    this.processes.delete(task);
  }

  private send(task: string, message: RoomServerMessage): void {
    for (const listener of this.listeners.get(task) ?? []) listener(message);
  }
}
