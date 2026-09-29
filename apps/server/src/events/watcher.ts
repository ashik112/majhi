import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import type { EventTopic } from "@majhi/shared";
import { CONFIG_FILE_NAME } from "../config/load.ts";
import { AGENTS_DIR_NAME } from "../config/service.ts";
import type { EventHub } from "./hub.ts";

const DEBOUNCE_MS = 200;
const RETRY_MS = 1_000;

/**
 * Watches `majhi.yaml` and `agents/` for hand edits and tells the hub.
 * Either may not exist yet: it keeps looking until they do. Changes made by
 * commands are seen too, which only means a client refetches once more.
 */
export class HomeWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly pending = new Set<EventTopic>();
  private debounce: NodeJS.Timeout | undefined;
  private retry: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly majhiHome: string,
    private readonly hub: EventHub,
    private readonly debounceMs = DEBOUNCE_MS,
  ) {}

  start(): void {
    this.attach();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.debounce);
    clearTimeout(this.retry);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  private attach(): void {
    if (this.stopped) return;
    const homeOk = this.watchDir(this.majhiHome, (name) => {
      if (name === CONFIG_FILE_NAME || name === null) this.touch("config", "orgs", "accounts", "agents");
      if (name === AGENTS_DIR_NAME || name === null) {
        this.watchAgents();
        this.touch("agents");
      }
    });
    if (homeOk) {
      this.watchAgents();
    } else {
      this.retryLater();
    }
  }

  private watchAgents(): void {
    this.watchDir(join(this.majhiHome, AGENTS_DIR_NAME), (file) => {
      if (file === null || file.endsWith(".md")) this.touch("agents");
    });
  }

  private retryLater(): void {
    if (this.retry !== undefined || this.stopped) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.attach();
      // Whatever appeared while nothing was watching has not been reported.
      if (this.watchers.has(this.majhiHome)) this.touch("config", "orgs", "accounts", "agents");
    }, RETRY_MS);
    this.retry.unref();
  }

  /** Starts watching `dir` once. False when it does not exist. */
  private watchDir(dir: string, onChange: (name: string | null) => void): boolean {
    if (this.watchers.has(dir)) return true;
    try {
      const watcher = watch(dir, (_event, name) => onChange(name));
      watcher.on("error", () => {
        watcher.close();
        this.watchers.delete(dir);
        // Folder removed or unreadable: look for it again.
        this.retryLater();
      });
      this.watchers.set(dir, watcher);
      return true;
    } catch {
      return false;
    }
  }

  private touch(...topics: EventTopic[]): void {
    for (const t of topics) this.pending.add(t);
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      const topics = [...this.pending];
      this.pending.clear();
      this.hub.emit(topics);
    }, this.debounceMs);
    this.debounce.unref();
  }
}
