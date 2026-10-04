import type {
  CliCheckResult,
  CliLoginResult,
  DirListing,
  E2eRunResult,
  EditorApp,
  GitCliLoginResult,
  GitLoginsResult,
  HostCloneProgress,
  HostJob,
  HostLoginProgress,
  HostProgress,
  HostReply,
  LayaDecideResult,
  LayaStatus,
  MachineHost,
  RootSuggestion,
  SecretsKeyBackup,
  SecretsKeyRestore,
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
  /** Load, memory and free disk of this computer. Absent in tests that do not read them. */
  machineRead?: () => Promise<MachineHost>;
  /** Starts the update and returns false when one is already running. Undefined without a checkout or docker. */
  update: (() => boolean) | undefined;
  /** Ends the helper so its login service (launchd or systemd) starts it again. */
  restart(): void;
  /** Throws an error whose message is safe to show. It never holds the passphrase. */
  sshUnlock(params: { key: string; passphrase: string }): Promise<SshStatus>;
  /** Throws an error whose message is safe to show. It never holds the key. */
  secretsKeySave(params: { expected: string }): Promise<SecretsKeyBackup>;
  /**
   * Writes a restored secrets key when the key file is missing or does not open secrets.age.
   * `after` restarts majhi, so it runs once the reply is sent, and never throws. Throws an error
   * whose message is safe to show. It never holds the key.
   */
  secretsKeyRestore?: (params: {
    key: string;
  }) => Promise<{ result: SecretsKeyRestore; after: () => Promise<void> }>;
  gitLogins(params: { extraHosts: string[] }): Promise<GitLoginsResult>;
  /** Throws an error whose message is safe to show. The token is only ever in the return value. */
  gitToken(params: { via: "gh" | "glab"; host: string }): Promise<string>;
  /** Throws an error whose message is safe to show. With `auth`, the workspace's credential is used. */
  gitPush(params: Extract<HostJob, { method: "git.push" }>["params"]): Promise<void>;
  /** Throws an error whose message is safe to show. The secret is only ever in the return value. */
  gitCredential(params: { host: string; username: string }): Promise<string>;
  layaStatus(): LayaStatus;
  /** Starts the install if needed and returns the state at once. */
  layaInstall(): LayaStatus;
  /** Throws an error whose message is safe to show when the editor cannot open the path. */
  editorOpen(params: { app: EditorApp; path: string; line?: number | undefined }): Promise<void>;
  /** Resolves when the suite ended, passed or not. Throws an error whose message is safe to show when it cannot start. */
  e2eRun(params: Extract<HostJob, { method: "e2e.run" }>["params"]): Promise<E2eRunResult>;
  layaDecide(params: Extract<HostJob, { method: "decide" }>["params"]): Promise<LayaDecideResult>;
  /** Throws an error whose message is safe to show when the computer shows nothing. */
  notify(params: Extract<HostJob, { method: "notify" }>["params"]): Promise<{ clickable: boolean }>;
  /** Opens an http(s) page in the owner's browser (`Platform.openUrl`). False when nothing could open it. */
  openUrl?: (params: Extract<HostJob, { method: "openUrl" }>["params"]) => Promise<boolean>;
  /**
   * Clones with the job's credential through majhi's own askpass, into a temporary sibling that is
   * renamed to `path` when done and removed on failure. Calls `progress` as git reports phases.
   * Throws an error whose message is safe to show: never git's raw output or the token.
   */
  gitClone?: (
    params: Extract<HostJob, { method: "git.clone" }>["params"],
    progress: (progress: Omit<HostCloneProgress, "id">) => void,
  ) => Promise<{ head: string; branch: string }>;
  /** `git ls-remote --symref` with the job's credential. Throws a safe sentence when unreachable. */
  gitLsRemote?: (
    params: Extract<HostJob, { method: "git.lsRemote" }>["params"],
  ) => Promise<{ empty: boolean; defaultBranch?: string | undefined }>;
  /**
   * Signs a workspace in with `gh` or `glab` in the browser, in a config folder of its own, and
   * answers the token. Calls `progress` once the page (and code) are known. Throws an error whose
   * message is safe to show: never the CLI's output or the token.
   */
  gitCliLogin?: (
    params: Extract<HostJob, { method: "git.cliLogin" }>["params"],
    progress: (progress: Omit<HostLoginProgress, "id">) => void,
  ) => Promise<GitCliLoginResult>;
  /** Stops a running `gitCliLogin`. False when none runs for that sign-in. */
  gitCliLoginCancel?: (params: Extract<HostJob, { method: "git.cliLoginCancel" }>["params"]) => boolean;
  /** Signs a workspace in to a command-line tool in its connection's own profile folder. */
  cliLogin?: (
    params: Extract<HostJob, { method: "cli.login" }>["params"],
    progress: (progress: Omit<HostLoginProgress, "id">) => void,
  ) => Promise<CliLoginResult>;
  cliLoginCancel?: (params: Extract<HostJob, { method: "cli.loginCancel" }>["params"]) => boolean;
  cliCheck?: (params: Extract<HostJob, { method: "cli.check" }>["params"]) => Promise<CliCheckResult>;
  cliLogout?: (params: Extract<HostJob, { method: "cli.logout" }>["params"]) => Promise<{ revoked: boolean }>;
}

/** Sends progress for a running job to `POST /api/host/progress`. Failures are dropped. */
export type SendProgress = (progress: HostProgress) => Promise<void>;

/** The answer for a job this helper has no handler for yet. Names no operating system. */
export const NOT_BUILT_JOB = "This host helper cannot do that yet. Update majhi and try again.";

export type SendReply = (reply: HostReply) => Promise<void>;

export const CANNOT_UPDATE =
  "The host helper cannot run docker compose here, so it cannot update majhi. Run `make up` in the majhi folder.";

export const CANNOT_REMOUNT =
  "The host helper cannot run docker compose here. Run `make up` in the majhi folder to mount the new roots.";

/**
 * Runs one job and sends its reply. A failing job is answered with its
 * message; nothing here throws. `remount` and `secretsKey.restore` are
 * answered before they restart the server the reply goes to.
 */
export async function runJob(
  job: HostJob,
  handlers: JobHandlers,
  reply: SendReply,
  sendProgress: SendProgress = async () => undefined,
): Promise<void> {
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
      case "machine.read":
        if (handlers.machineRead === undefined) {
          await reply({ id: job.id, ok: false, error: NOT_BUILT_JOB });
          return;
        }
        await reply({ id: job.id, ok: true, result: await handlers.machineRead() });
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
      case "e2e.run":
        await reply({ id: job.id, ok: true, result: await handlers.e2eRun(job.params) });
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
      case "openUrl": {
        if (handlers.openUrl === undefined) {
          await reply({ id: job.id, ok: true, result: { opened: false } });
          return;
        }
        await reply({ id: job.id, ok: true, result: { opened: await handlers.openUrl(job.params) } });
        return;
      }
      case "git.clone": {
        if (handlers.gitClone === undefined) {
          await reply({ id: job.id, ok: false, error: NOT_BUILT_JOB });
          return;
        }
        const result = await handlers.gitClone(job.params, (progress) => {
          void sendProgress({ id: job.id, ...progress }).catch(() => undefined);
        });
        await reply({ id: job.id, ok: true, result });
        return;
      }
      case "git.lsRemote": {
        if (handlers.gitLsRemote === undefined) {
          await reply({ id: job.id, ok: false, error: NOT_BUILT_JOB });
          return;
        }
        await reply({ id: job.id, ok: true, result: await handlers.gitLsRemote(job.params) });
        return;
      }
      case "git.cliLogin": {
        if (handlers.gitCliLogin === undefined) {
          await reply({ id: job.id, ok: false, error: NOT_BUILT_JOB });
          return;
        }
        const result = await handlers.gitCliLogin(job.params, (progress) => {
          void sendProgress({ id: job.id, ...progress }).catch(() => undefined);
        });
        await reply({ id: job.id, ok: true, result });
        return;
      }
      case "git.cliLoginCancel":
        await reply({
          id: job.id,
          ok: true,
          result: { cancelled: handlers.gitCliLoginCancel?.(job.params) ?? false },
        });
        return;
      case "cli.login": {
        if (handlers.cliLogin === undefined) {
          await reply({ id: job.id, ok: false, error: NOT_BUILT_JOB });
          return;
        }
        const result = await handlers.cliLogin(job.params, (progress) => {
          void sendProgress({ id: job.id, ...progress }).catch(() => undefined);
        });
        await reply({ id: job.id, ok: true, result });
        return;
      }
      case "cli.loginCancel":
        await reply({
          id: job.id,
          ok: true,
          result: { cancelled: handlers.cliLoginCancel?.(job.params) ?? false },
        });
        return;
      case "cli.check": {
        if (handlers.cliCheck === undefined) {
          await reply({ id: job.id, ok: false, error: NOT_BUILT_JOB });
          return;
        }
        await reply({ id: job.id, ok: true, result: await handlers.cliCheck(job.params) });
        return;
      }
      case "cli.logout": {
        if (handlers.cliLogout === undefined) {
          await reply({ id: job.id, ok: false, error: NOT_BUILT_JOB });
          return;
        }
        await reply({ id: job.id, ok: true, result: await handlers.cliLogout(job.params) });
        return;
      }
      case "git.credential":
        await reply({ id: job.id, ok: true, result: { secret: await handlers.gitCredential(job.params) } });
        return;
      case "ssh.unlock":
        await reply({ id: job.id, ok: true, result: await handlers.sshUnlock(job.params) });
        return;
      case "secretsKey.save":
        await reply({ id: job.id, ok: true, result: await handlers.secretsKeySave(job.params) });
        return;
      case "secretsKey.restore": {
        if (handlers.secretsKeyRestore === undefined) {
          await reply({ id: job.id, ok: false, error: NOT_BUILT_JOB });
          return;
        }
        const { result, after } = await handlers.secretsKeyRestore(job.params);
        await reply({ id: job.id, ok: true, result });
        await after();
        return;
      }
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
