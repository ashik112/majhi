import type { CommandMeta, Settings, WorkspacesUpdate } from "@majhi/shared";
import { UserError } from "../errors.ts";
import { fileSignature } from "../fs.ts";
import { ConfigHistory, type HistoryEntry } from "./history.ts";
import { CONFIG_FILE_NAME, type ConfigPaths, configFilePath, type LoadedConfig, loadConfig } from "./load.ts";
import { foldedOrgs, orgsWithMergeSwitch, removeOrgMergeSwitches } from "./migrate-org-merge.ts";
import { applyWrites, planPrivateRename, RENAME_PRIVATE_SUMMARY } from "./migrate-private.ts";
import { type ConfigSections, readSections } from "./sections.ts";
import { readSettings, type SettingsPatch } from "./settings.ts";
import { writeSettings, writeWorkspaces } from "./write.ts";

/** Folder of agent files, kept in the same history as majhi.yaml. */
export const AGENTS_DIR_NAME = "agents";
const TRACKED = [CONFIG_FILE_NAME, AGENTS_DIR_NAME];

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

  /** The last load with the signature of majhi.yaml it came from; a hand edit changes the signature. */
  private loaded: { signature: string; config: LoadedConfig } | undefined;

  async load(): Promise<LoadedConfig> {
    const signature = await fileSignature(this.file).catch(() => undefined);
    if (signature !== undefined && this.loaded?.signature === signature) {
      return structuredClone(this.loaded.config);
    }
    const config = await loadConfig(this.paths);
    this.loaded = signature === undefined ? undefined : { signature, config: structuredClone(config) };
    return config;
  }

  async sections(): Promise<ConfigSections> {
    const sections = await this.cached("sections", () => readSections(this.file));
    this.boss = sections.boss;
    return sections;
  }

  /**
   * The last parse of majhi.yaml per reader, kept while the file's signature holds. Every page and tick
   * reads the settings many times; parsing YAML each time kept the server busy. A hand edit or a write
   * changes the signature, so the next read parses again. Callers get their own copy.
   */
  private parsed = new Map<string, { signature: string; value: unknown }>();

  private async cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    const signature = await fileSignature(this.file).catch(() => undefined);
    const hit = this.parsed.get(key);
    if (signature !== undefined && hit?.signature === signature) return structuredClone(hit.value as T);
    const value = await read();
    if (signature === undefined) this.parsed.delete(key);
    else this.parsed.set(key, { signature, value: structuredClone(value) });
    return value;
  }

  /** The captain as of the last read of majhi.yaml, for code that cannot wait for a read. */
  private boss: string | undefined;

  knownBoss(): string | undefined {
    return this.boss;
  }

  setWorkspaces(update: WorkspacesUpdate, change: ChangeRecord): Promise<LoadedConfig> {
    return this.change(change, () => writeWorkspaces(this.file, update));
  }

  /**
   * Runs one change: commits hand edits first, lets `write` change majhi.yaml
   * or the agent files, commits the result with the actor, command and reason,
   * and reloads the config. Changes run one at a time.
   */
  change(change: ChangeRecord, write: () => Promise<void>): Promise<LoadedConfig> {
    return this.serialize(async () => {
      await this.commitPending();
      await write();
      const reason = change.meta.reason?.trim();
      await this.history.commit({
        files: TRACKED,
        message: `${change.command}: ${reason ? reason : change.summary}`,
        actor: change.meta.actor,
        trailers: {
          Command: change.command,
          Actor: change.meta.actor.kind === "owner" ? "owner" : change.meta.actor.id,
          Summary: change.summary,
          ...(reason ? { Reason: reason } : {}),
        },
      });
      return this.load();
    });
  }

  /**
   * Startup migration: the built-in org used to be called `personal`. Rewrites every reference to
   * `private` in one config commit by actor majhi, so History shows it with Undo. Returns whether
   * it changed anything. A second run finds nothing and makes no commit.
   */
  async migrateLegacyOrg(): Promise<boolean> {
    if ((await planPrivateRename(this.paths.majhiHome)).length === 0) return false;
    let changed = false;
    await this.change(
      {
        command: "config.migrate",
        meta: { actor: { kind: "agent", id: "majhi" } },
        summary: RENAME_PRIVATE_SUMMARY,
      },
      async () => {
        const writes = await planPrivateRename(this.paths.majhiHome);
        changed = writes.length > 0;
        await applyWrites(writes);
      },
    );
    return changed;
  }

  /**
   * Startup migration: `tasks.updateTarget` (a fast-forward from the remote) moved from the Hands-off
   * preset's "confirm" to "auto". A stored `confirm` for exactly that command is the old preset value,
   * so it becomes `auto`. Any other stored mode is the owner's own choice and stays. Returns whether it
   * changed anything; a second run finds nothing and makes no commit.
   */
  async migrateUpdateTargetPolicy(): Promise<boolean> {
    const COMMAND = "tasks.updateTarget";
    const stale = async (): Promise<boolean> =>
      (await readSettings(this.file)).policy.commands[COMMAND] === "confirm";
    if (!(await stale())) return false;
    let changed = false;
    await this.change(
      {
        command: "config.migrate",
        meta: { actor: { kind: "agent", id: "majhi" } },
        summary: "Updating a local branch from its remote no longer asks",
      },
      async () => {
        if (!(await stale())) return;
        changed = true;
        const { commands } = (await readSettings(this.file)).policy;
        await writeSettings(this.file, { policy: { commands: { ...commands, [COMMAND]: "auto" } } });
      },
    );
    return changed;
  }

  /**
   * Startup migration: `orgs.<id>.merge` (never, approve, auto-if-green) folds into the Merge row of the
   * authority table and the key is removed (see `migrate-org-merge.ts`). Returns whether it changed
   * anything; a second run finds nothing and makes no commit.
   */
  async migrateOrgMerge(): Promise<boolean> {
    if ((await orgsWithMergeSwitch(this.file)).length === 0) return false;
    let changed = false;
    await this.change(
      {
        command: "config.migrate",
        meta: { actor: { kind: "agent", id: "majhi" } },
        summary: "Folded each workspace's merge policy into the Merge row of the Permissions table",
      },
      async () => {
        const found = await orgsWithMergeSwitch(this.file);
        if (found.length === 0) return;
        changed = true;
        const { autonomy } = await readSettings(this.file);
        const orgs = foldedOrgs(autonomy, found);
        if (orgs !== undefined) await writeSettings(this.file, { autonomy: { orgs } });
        await removeOrgMergeSwitches(
          this.file,
          found.map((f) => f.id),
        );
      },
    );
    return changed;
  }

  /** Context budget, limits, resume and policy from majhi.yaml, with defaults applied. */
  settings(): Promise<Settings> {
    return this.cached("settings", () => readSettings(this.file));
  }

  /** Writes only the fields in the patch. */
  setSettings(patch: SettingsPatch, change: ChangeRecord): Promise<LoadedConfig> {
    return this.change(change, () => writeSettings(this.file, patch));
  }

  /** Config commits, newest first. */
  historyEntries(limit: number): Promise<HistoryEntry[]> {
    return this.serialize(() => this.history.entries(limit));
  }

  /**
   * Undoes one commit of the history with a new commit. Refuses when the change is already undone,
   * is the start of the history, or a later change touched the same lines.
   */
  undo(commit: string, change: ChangeRecord): Promise<{ commit: string; summary: string; undone: string }> {
    return this.serialize(async () => {
      await this.commitPending();
      const full = await this.history.resolve(commit);
      if (full === undefined) throw new UserError(`There is no change ${commit} in the history.`, 404);
      const entries = await this.history.entries(500);
      const entry = entries.find((e) => e.commit === full);
      if (entry === undefined || (await this.history.parents(full)) === 0) {
        throw new UserError("That change is the start of the history and cannot be undone.");
      }
      if (entry.undone) throw new UserError("That change is already undone.", 409);
      const reason = change.meta.reason?.trim();
      const done = await this.history.revert(full, {
        message: `undo: ${entry.summary}`,
        actor: change.meta.actor,
        trailers: {
          Command: change.command,
          Actor: change.meta.actor.kind === "owner" ? "owner" : change.meta.actor.id,
          Summary: `undid ${entry.summary}`,
          ...(reason ? { Reason: reason } : {}),
        },
      });
      if ("failed" in done) {
        throw new UserError(
          done.failed === "conflict"
            ? "A later change touched the same lines, so this cannot be undone on its own. Undo the later change first."
            : "Undoing this would change nothing.",
          409,
        );
      }
      return { commit: done.commit, summary: entry.summary, undone: full };
    });
  }

  /**
   * Starts the history on first use, and commits edits made by hand since the
   * last change, so undoing a command never undoes the owner's own edits.
   * Lines majhi adds to `.gitignore` later get their own commit.
   */
  private async commitPending(): Promise<void> {
    const { initialized, changed } = await this.history.ensureRepo();
    if (initialized) {
      await this.history.commit({
        files: [...TRACKED, ...changed],
        message: "init: start config history",
        actor: OWNER,
      });
      return;
    }
    if (changed.length > 0) {
      await this.history.commit({
        files: changed,
        message: "gitignore: keep new private files out of the history",
        actor: OWNER,
      });
    }
    if (await this.history.hasChanges(TRACKED)) {
      await this.history.commit({
        files: TRACKED,
        message: "manual: changes made outside majhi",
        actor: OWNER,
      });
    }
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
