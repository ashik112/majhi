import type {
  DirListing,
  EditorApp,
  GitLoginsResult,
  HostJob,
  HostReply,
  LayaDecideResult,
  LayaStatus,
  RootSuggestion,
  SshStatus,
} from "@majhi/shared";
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
  gitLogins(params: { extraHosts: string[] }): Promise<GitLoginsResult>;
  /** Throws an error whose message is safe to show. The token is only ever in the return value. */
  gitToken(params: { via: "gh" | "glab"; host: string }): Promise<string>;
  /** Throws an error whose message is safe to show. */
  gitPush(params: { path: string; url: string; branch: string }): Promise<void>;
  /** Throws an error whose message is safe to show. The secret is only ever in the return value. */
  gitCredential(params: { host: string; username: string }): Promise<string>;
  layaStatus(): LayaStatus;
  /** Starts the install if needed and returns the state at once. */
  layaInstall(): LayaStatus;
  /** Throws an error whose message is safe to show when the editor cannot open the path. */
  editorOpen(params: { app: EditorApp; path: string; line?: number | undefined }): Promise<void>;
  layaDecide(params: Extract<HostJob, { method: "decide" }>["params"]): Promise<LayaDecideResult>;
  /** Throws an error whose message is safe to show when macOS shows nothing. */
  notify(params: Extract<HostJob, { method: "notify" }>["params"]): Promise<{ clickable: boolean }>;
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
      case "decisions.status":
        await reply({ id: job.id, ok: true, result: handlers.layaStatus() });
        return;
      case "decisions.install":
        await reply({ id: job.id, ok: true, result: handlers.layaInstall() });
        return;
      case "decide":
        await reply({ id: job.id, ok: true, result: await handlers.layaDecide(job.params) });
        return;
      case "editor.open":
        await handlers.editorOpen(job.params);
        await reply({ id: job.id, ok: true, result: { opened: true } });
        return;
      case "notify": {
        const { clickable } = await handlers.notify(job.params);
        await reply({ id: job.id, ok: true, result: { shown: true, clickable } });
        return;
      }
      case "git.logins":
        await reply({ id: job.id, ok: true, result: await handlers.gitLogins(job.params) });
        return;
      case "git.token":
        await reply({ id: job.id, ok: true, result: { token: await handlers.gitToken(job.params) } });
        return;
      case "git.push":
        await handlers.gitPush(job.params);
        await reply({ id: job.id, ok: true, result: { pushed: true } });
        return;
      case "git.credential":
        await reply({ id: job.id, ok: true, result: { secret: await handlers.gitCredential(job.params) } });
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
