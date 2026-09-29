import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type CommandOutput, UPDATE_STATUS_FILE, type UpdateStatus, UpdateStatusSchema } from "@majhi/shared";
import { HostJobError, type HostLink, HostOfflineError } from "../host/link.ts";
import { isUpdateReady } from "./version.ts";

export interface SystemDeps {
  hostLink: HostLink;
  /** The commit the running image was built from. */
  commit: string;
  majhiHome: string;
  /** Agents in the middle of a turn right now. Default: none. */
  working?: () => number;
  /** How often a waiting update looks again. Default 2 s. */
  waitPollMs?: number;
}

const NO_HELPER =
  "The host helper is not connected, so majhi cannot rebuild itself from here. Run `make up` in the majhi folder.";
const NO_DOCKER =
  "The host helper cannot run Docker here, so majhi cannot rebuild itself from here. Run `make up` in the majhi folder.";

/** `system.version` and `system.update`: compare the running commit with the checkout, and rebuild through the helper. */
export class SystemService {
  private waiter: NodeJS.Timeout | undefined;

  constructor(private readonly deps: SystemDeps) {}

  /** True while an update waits for the working agents to finish. */
  get waiting(): boolean {
    return this.waiter !== undefined;
  }

  /** Stops a waiting update, for shutdown. */
  close(): void {
    if (this.waiter !== undefined) clearInterval(this.waiter);
    this.waiter = undefined;
  }

  async version(): Promise<CommandOutput<"system.version">> {
    const { hostLink, commit } = this.deps;
    const status = hostLink.status();
    const info = status.connected ? status.info : undefined;
    const onDisk = info?.commit;
    const update = await this.readUpdate();
    const out: CommandOutput<"system.version"> = {
      running: commit,
      updateReady: isUpdateReady(commit, onDisk),
      changes: [],
      canUpdate: status.connected && info?.canRemount === true,
      working: this.deps.working?.() ?? 0,
      waiting: this.waiting,
    };
    if (onDisk !== undefined) out.onDisk = onDisk;
    if (info?.dirty !== undefined) out.dirty = info.dirty;
    if (update !== undefined) out.update = update;
    if (out.updateReady && /^[0-9a-f]{7,64}$/.test(commit)) {
      try {
        const result = await hostLink.call("version.changes", { from: commit });
        out.changes = result.changes;
        out.dirty = result.dirty;
      } catch {
        // The list is a courtesy. The update itself does not need it.
      }
    }
    return out;
  }

  /**
   * `now` starts the rebuild at once; turns in flight are cut and resume after the restart.
   * `idle` waits until no agent is working, then starts it. Either way the helper must be able to.
   */
  async update(when: "now" | "idle" = "now"): Promise<CommandOutput<"system.update">> {
    const blocked = this.blocked();
    if (blocked !== undefined) return blocked;
    if (when === "now" || (this.deps.working?.() ?? 0) === 0) {
      this.close();
      return this.start();
    }
    if (this.waiter === undefined) {
      this.waiter = setInterval(() => {
        if ((this.deps.working?.() ?? 0) > 0) return;
        this.close();
        void this.start().catch(() => undefined);
      }, this.deps.waitPollMs ?? 2000);
      this.waiter.unref();
    }
    return { state: "waiting" };
  }

  /** Why the helper cannot run the update, or undefined when it can. */
  private blocked(): CommandOutput<"system.update"> | undefined {
    const status = this.deps.hostLink.status();
    if (!status.connected) return { state: "manual", reason: NO_HELPER };
    if (status.info?.canRemount !== true) return { state: "manual", reason: NO_DOCKER };
    return undefined;
  }

  private async start(): Promise<CommandOutput<"system.update">> {
    const { hostLink } = this.deps;
    // The helper may have gone away while the update waited.
    const blocked = this.blocked();
    if (blocked !== undefined) return blocked;
    try {
      await hostLink.call("update", {});
      return { state: "restarting" };
    } catch (err) {
      if (err instanceof HostOfflineError) return { state: "manual", reason: NO_HELPER };
      if (err instanceof HostJobError) return { state: "manual", reason: err.message };
      throw err;
    }
  }

  /** What the helper wrote to `update.json`. Missing or unreadable means no update has run. */
  private async readUpdate(): Promise<UpdateStatus | undefined> {
    try {
      const text = await readFile(join(this.deps.majhiHome, UPDATE_STATUS_FILE), "utf8");
      const parsed = UpdateStatusSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
}
