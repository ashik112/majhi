import { mkdir } from "node:fs/promises";
import { type CommandOutput, hostOsOf, keyringName, type Remount } from "@majhi/shared";
import type { ConfigService } from "../config/service.ts";
import type { ServerEnv } from "../env.ts";
import { errorMessage } from "../errors.ts";
import { isDirectory } from "../fs.ts";
import type { HostLink } from "../host/link.ts";
import type { Services } from "../services.ts";
import type { SshHostProbe } from "../ssh/hosts.ts";
import { sizeText } from "../tasks/folder-sweep.ts";
import { type Check, collectChecks, type ToolCache } from "./checks.ts";

/** Loading keys and asking the Keychain or keyring can take a few seconds. */
const SSH_CALL_TIMEOUT_MS = 40_000;
/** The Keychain or keyring can be slow to answer the first time after a login. */
const KEYCHAIN_CALL_TIMEOUT_MS = 30_000;

export interface HealthDeps {
  env: ServerEnv;
  services: Services;
  config: ConfigService;
  hostLink: HostLink;
  sshHosts?: SshHostProbe | undefined;
  /** Asks the helper to remount when roots are missing. */
  remount: (unmounted: readonly string[]) => Promise<Remount>;
  /** Rebuilds majhi through the host helper once no agent is working (`system.update`). */
  rebuild?: () => Promise<CommandOutput<"system.update">>;
}

type RunOutput = CommandOutput<"health.run">;
type FixOutput = CommandOutput<"health.fix">;

/** `health.run` and `health.fix`: the doctor checks for the UI, and the fix behind each Fix button. */
export class HealthService {
  private readonly toolCache: ToolCache = new Map();

  constructor(private readonly deps: HealthDeps) {}

  async checks(): Promise<Check[]> {
    const { env, services, config, hostLink, sshHosts } = this.deps;
    const loaded = await config.load();
    return collectChecks({
      env,
      services,
      config: loaded,
      host: { status: hostLink.status() },
      sshHosts: async () => sshHosts?.cached() ?? (await sshHosts?.refresh()) ?? [],
      accounts: "cached",
      toolCache: this.toolCache,
    });
  }

  async run(): Promise<RunOutput> {
    const checks = await this.checks();
    return {
      checkedAt: new Date().toISOString(),
      checks: checks.map((c) => ({
        id: c.id,
        group: c.group,
        label: c.name,
        ok: c.status !== "fail",
        level: c.status,
        detail: c.detail,
        ...(c.fix === undefined ? {} : { fix: c.fix }),
      })),
    };
  }

  /** Runs the fix for one check. Answers with what happened in plain words. */
  async fix(id: string, actor: "owner" | "agent" | "other" = "owner"): Promise<FixOutput> {
    const { env, services, config, hostLink, sshHosts, remount } = this.deps;
    try {
      if (id === "config-folder") {
        await mkdir(env.majhiHome, { recursive: true });
        return { ok: true, detail: "Created the config folder." };
      }
      if (id === "task-folders") {
        if (actor !== "owner") return { ok: false, detail: "Only the owner frees space in task folders." };
        const { cleanup } = await config.settings();
        const report = await services.folderSweep.run({
          hours: cleanup.free_after_hours,
          worktreeDays: cleanup.worktree_after_days,
        });
        const n = report.tasks.filter((t) => t.bytes > 0).length;
        return {
          ok: true,
          detail:
            report.freedBytes === 0
              ? "Nothing to free: every done task is already clean, or has changes that stay."
              : `Freed ${sizeText(report.freedBytes)} in ${n} done ${n === 1 ? "task" : "tasks"}.`,
        };
      }
      if (id === "tasks-dir") {
        const { state } = await config.load();
        if (state.status !== "loaded")
          return { ok: false, detail: "majhi.yaml does not load, so the tasks folder is not known." };
        await mkdir(state.config.tasksDir, { recursive: true });
        return { ok: true, detail: "Created the tasks folder." };
      }
      if (id.startsWith("root:")) {
        const { state } = await config.load();
        const roots = state.status === "loaded" ? state.config.workspaces : [];
        const missing: string[] = [];
        for (const root of roots) if (!(await isDirectory(root))) missing.push(root);
        if (missing.length === 0) return { ok: true, detail: "Every root is already mounted." };
        const result = await remount(missing);
        return result === "restarting"
          ? { ok: true, detail: "majhi is restarting to mount the folder. It comes back in a few seconds." }
          : {
              ok: false,
              detail: "The host helper could not remount. Run `make up` in the majhi folder once.",
            };
      }
      if (id === "ssh-agent" || id.startsWith("ssh-host:")) {
        const ssh = await hostLink.call("ssh.reload", {}, SSH_CALL_TIMEOUT_MS);
        hostLink.noteSsh(ssh);
        await sshHosts?.refresh().catch(() => undefined);
        return ssh.loaded > 0
          ? { ok: true, detail: `Loaded your SSH keys (${ssh.loaded} in the agent).` }
          : { ok: false, detail: ssh.error ?? "No SSH key could be loaded." };
      }
      if (id.startsWith("account:")) {
        const account = id.slice("account:".length);
        const view = (await services.accounts.list()).find((a) => a.id === account);
        if (view === undefined) return { ok: false, detail: `There is no account ${account}.` };
        if (view.status === "needs-login" || view.status === "relogin-soon") {
          return {
            ok: true,
            detail: `Sign in to ${account} in the terminal that opens.`,
            open: { kind: "sign-in", account },
          };
        }
        const { health } = await services.accounts.health(account, true);
        return health.ok
          ? { ok: true, detail: `${account} answered.` }
          : { ok: false, detail: health.steps.find((s) => !s.ok)?.detail ?? `${account} did not answer.` };
      }
      if (id === "backups") {
        const name = await services.backup.now();
        return { ok: true, detail: `Backed up (${name}).` };
      }
      if (id === "backups-verify") {
        const { result } = await services.backup.verify();
        return {
          ok: result.ok,
          detail: result.ok ? `The test restore worked: ${result.detail}` : result.detail,
        };
      }
      if (id === "runner" && this.deps.rebuild !== undefined) {
        this.toolCache.delete("runner");
        const result = await this.deps.rebuild();
        if (result.state === "manual") return { ok: false, detail: result.reason ?? "Run `make up` once." };
        return {
          ok: true,
          detail:
            result.state === "waiting"
              ? "majhi rebuilds once the agents finish their turns, then restarts."
              : "majhi is rebuilding and restarts in a few minutes.",
        };
      }
      if (id.startsWith("connection:")) {
        const result = await services.connectionTests.test(id.slice("connection:".length));
        return { ok: result.ok, detail: result.ok ? `It works again. ${result.detail}` : result.detail };
      }
      if (id === "secrets-key") {
        // The export and its passphrase are the owner's to give, so the browser shows the form.
        return {
          ok: true,
          detail: "Choose the export file and type its passphrase.",
          open: { kind: "key-restore" },
        };
      }
      if (id === "secrets-key-keychain") {
        const expected = await services.secrets.fingerprint();
        if (expected === undefined) return { ok: false, detail: "There is no secrets key to save yet." };
        // The keyring may hold the right key: never replace it with one that cannot read secrets.age.
        if ((await services.secrets.keyState()) !== "ok") {
          return { ok: false, detail: "The key file does not open secrets.age, so it was not saved." };
        }
        const saved = await hostLink.call("secretsKey.save", { expected }, KEYCHAIN_CALL_TIMEOUT_MS);
        hostLink.noteSecretsKey(saved);
        const where = keyringName(hostOsOf(hostLink.status().info));
        return { ok: true, detail: `Saved a copy of the secrets key in ${where} as "majhi secrets key".` };
      }
      if (id === "secrets-key-export") {
        // The passphrase is the owner's to type, so the browser shows the form.
        return { ok: true, detail: "Choose a passphrase for the export.", open: { kind: "key-export" } };
      }
      if (id === "host-helper") {
        await hostLink.call("restart", {});
        return { ok: true, detail: "The host helper is restarting. It reconnects in a few seconds." };
      }
      return { ok: false, detail: "majhi has no fix for this check." };
    } catch (err) {
      return { ok: false, detail: errorMessage(err) };
    }
  }
}
