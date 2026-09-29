import type { CommandMeta, WorkspacesUpdate } from "@majhi/shared";
import { ConfigHistory } from "./history.ts";
import { CONFIG_FILE_NAME, type ConfigPaths, configFilePath, type LoadedConfig, loadConfig } from "./load.ts";
import { writeWorkspaces } from "./write.ts";

export interface ChangeRecord {
  /** Command name, the first part of the commit message. */
  command: string;
  meta: CommandMeta;
  /** Used in the commit message when the caller gave no reason. */
  summary: string;
}

const OWNER = { kind: "owner" } as const;

/**
 * Reads majhi.yaml on every call, so hand edits show up at once, and writes
 * it one change at a time, each change committed to the config history.
 */
export class ConfigService {
  readonly file: string;
  readonly history: ConfigHistory;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly paths: ConfigPaths) {
    this.file = configFilePath(paths.majhiHome);
    this.history = new ConfigHistory(paths.majhiHome);
  }

  load(): Promise<LoadedConfig> {
    return loadConfig(this.paths);
  }

  setWorkspaces(update: WorkspacesUpdate, change: ChangeRecord): Promise<LoadedConfig> {
    return this.serialize(async () => {
      await this.commitPending();
      await writeWorkspaces(this.file, update);
      const reason = change.meta.reason?.trim();
      await this.history.commit({
        files: [CONFIG_FILE_NAME],
        message: `${change.command}: ${reason ? reason : change.summary}`,
        actor: change.meta.actor,
      });
      return this.load();
    });
  }

  /**
   * Starts the history on first use, and commits edits made by hand since the
   * last change, so undoing a command never undoes the owner's own edits.
   */
  private async commitPending(): Promise<void> {
    const { initialized, created } = await this.history.ensureRepo();
    await this.history.commit({
      files: [CONFIG_FILE_NAME, ...created],
      message: initialized ? "init: start config history" : "manual: changes made outside majhi",
      actor: OWNER,
    });
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
