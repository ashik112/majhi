import type { DirListing, HostJob, HostReply, RootSuggestion, SshStatus } from "@majhi/shared";
import { errorMessage } from "./errors.ts";

export interface JobHandlers {
  listDirs(params: { path: string; showHidden: boolean }): Promise<DirListing>;
  suggestRoots(): Promise<RootSuggestion[]>;
  /** Undefined when this helper cannot run `docker compose`. */
  remount: (() => Promise<unknown>) | undefined;
  sshReload(): Promise<SshStatus>;
  /** HEAD of the checkout and the subjects after `from`. Throws when there is no checkout. */
  versionChanges(params: { from: string }): Promise<{ head: string; dirty: boolean; changes: string[] }>;
  /** Starts the update and returns false when one is already running. Undefined without a checkout or Docker. */
  update: (() => boolean) | undefined;
  /** Ends the helper so launchd starts it again. */
  restart(): void;
  /** Throws an error whose message is safe to show. It never holds the passphrase. */
  sshUnlock(params: { key: string; passphrase: string }): Promise<SshStatus>;
}

export type SendReply = (reply: HostReply) => Promise<void>;

export const CANNOT_UPDATE =
  "The host helper cannot run docker compose here, so it cannot update majhi. Run `make up` in the majhi folder.";

export const CANNOT_REMOUNT =
  "The host helper cannot run docker compose here. Run `make up` in the majhi folder to mount the new roots.";

/**
 * Runs one job and sends its reply. A failing job is answered with its
 * message; nothing here throws. `remount` is answered first, because it
 * restarts the server the reply goes to.
 */
export async function runJob(job: HostJob, handlers: JobHandlers, reply: SendReply): Promise<void> {
  try {
    switch (job.method) {
      case "listDirs":
        await reply({ id: job.id, ok: true, result: await handlers.listDirs(job.params) });
        return;
      case "suggestRoots":
        await reply({ id: job.id, ok: true, result: { suggestions: await handlers.suggestRoots() } });
        return;
      case "ssh.reload":
        await reply({ id: job.id, ok: true, result: await handlers.sshReload() });
        return;
      case "version.changes":
        await reply({ id: job.id, ok: true, result: await handlers.versionChanges(job.params) });
        return;
      case "update": {
        if (handlers.update === undefined) {
          await reply({ id: job.id, ok: false, error: CANNOT_UPDATE });
          return;
        }
        if (!handlers.update()) {
          await reply({ id: job.id, ok: false, error: "An update is already running." });
          return;
        }
        await reply({ id: job.id, ok: true, result: { accepted: true } });
        return;
      }
      case "restart":
        await reply({ id: job.id, ok: true, result: { accepted: true } });
        handlers.restart();
        return;
      case "ssh.unlock":
        await reply({ id: job.id, ok: true, result: await handlers.sshUnlock(job.params) });
        return;
      case "remount": {
        const remount = handlers.remount;
        if (remount === undefined) {
          await reply({ id: job.id, ok: false, error: CANNOT_REMOUNT });
          return;
        }
        await reply({ id: job.id, ok: true, result: { accepted: true } });
        await remount();
        return;
      }
    }
  } catch (err) {
    await reply({ id: job.id, ok: false, error: errorMessage(err) }).catch(() => undefined);
  }
}
