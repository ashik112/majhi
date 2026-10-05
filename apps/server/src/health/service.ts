import { mkdir } from "node:fs/promises";
import { type CommandOutput, type EventTopic, hostOsOf, keyringName, type Remount } from "@majhi/shared";
import type { ConfigService } from "../config/service.ts";
import type { ServerEnv } from "../env.ts";
import { errorMessage } from "../errors.ts";
import { isDirectory } from "../fs.ts";
import type { HostLink } from "../host/link.ts";
import type { Services } from "../services.ts";
import type { SshHostProbe } from "../ssh/hosts.ts";
import { sizeText } from "../tasks/folder-sweep.ts";
import { type Check, collectChecks, type ToolCache } from "./checks.ts";
import { type CheckUnit, runUnits } from "./run-all.ts";

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
  /** Told after each check finishes, so the page shows rows as they settle. */
  events?: { emit(topics: readonly EventTopic[]): void } | undefined;
  now?: () => Date;
}

/** Checks of a full run that go at once. Connection checks may start a runner container each. */
export const CHECK_ALL_CONCURRENCY = 4;

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

  private progress = { running: false, done: 0, total: 0 };
  private lastFullRunAt: string | undefined;
  /** An account or connection whose check threw: shown as failed until its next check works. */
  private readonly failures = new Map<string, { detail: string; at: string }>();

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private emit(...topics: EventTopic[]): void {
    this.deps.events?.emit(["checks", ...topics]);
  }

  async run(): Promise<RunOutput> {
    const checks = await this.checks();
    const stamp = this.now().toISOString();
    return {
      checkedAt: stamp,
      ...(this.lastFullRunAt === undefined ? {} : { lastFullRunAt: this.lastFullRunAt }),
      run: { ...this.progress },
      checks: checks.map((c) => {
        const failure = this.failures.get(c.id);
        if (failure !== undefined) {
          return {
            id: c.id,
            group: c.group,
            label: c.name,
            ok: false,
            level: "fail" as const,
            detail: failure.detail,
            checkedAt: failure.at,
          };
        }
        return {
          id: c.id,
          group: c.group,
          label: c.name,
          ok: c.status !== "fail",
          level: c.status,
          detail: c.detail,
          ...(c.fix === undefined ? {} : { fix: c.fix }),
          checkedAt: c.checkedAt ?? stamp,
        };
      }),
    };
  }

  /** The check of one account or connection. Its result is stored by the service that ran it. */
  private unitFor(id: string): CheckUnit | undefined {
    const { services } = this.deps;
    if (id.startsWith("account:")) {
      const account = id.slice("account:".length);
      return { id, weight: 1, run: () => this.settle(id, () => services.accounts.health(account, true)) };
    }
    if (id.startsWith("connection:")) {
      const connection = id.slice("connection:".length);
      return { id, weight: 1, run: () => this.settle(id, () => services.connectionTests.test(connection)) };
    }
    return undefined;
  }

  private async settle(id: string, check: () => Promise<unknown>): Promise<void> {
    try {
      await check();
      this.failures.delete(id);
    } catch (err) {
      this.failures.set(id, {
        detail: errorMessage(err).split("\n", 1)[0] ?? "Check failed",
        at: this.now().toISOString(),
      });
      throw err;
    }
  }

  /**
   * Checks everything: the doctor checks (read live), then every account's health and every
   * connection's real check, `CHECK_ALL_CONCURRENCY` at a time. Answers once the doctor checks are in and
   * the rest is going; each check that finishes tells the page. One that fails never stops the others.
   */
  async checkAll(): Promise<CommandOutput<"health.checkAll">> {
    if (this.progress.running) return { started: false, total: this.progress.total };
    this.progress = { running: true, done: 0, total: 0 };
    let units: CheckUnit[];
    try {
      this.toolCache.clear();
      const doctor = (await this.checks()).filter((c) => c.group !== "accounts" && c.group !== "connections");
      const { services } = this.deps;
      const [accounts, connections] = await Promise.all([
        services.accounts.list().catch(() => []),
        services.connections.list().catch(() => []),
      ]);
      units = [
        ...accounts.flatMap((a) => this.unitFor(`account:${a.id}`) ?? []),
        // A connection that is not set up has nothing to call.
        ...connections.flatMap((c) =>
          c.problems.length > 0 ? [] : (this.unitFor(`connection:${c.id}`) ?? []),
        ),
      ];
      const skipped = connections.filter((c) => c.problems.length > 0).length;
      this.progress = {
        running: true,
        done: doctor.length + skipped,
        total: doctor.length + skipped + units.length,
      };
    } catch (err) {
      this.progress = { running: false, done: 0, total: 0 };
      this.emit();
      throw err;
    }
    this.emit();
    void this.finish(units);
    return { started: true, total: this.progress.total };
  }

  private async finish(units: readonly CheckUnit[]): Promise<void> {
    try {
      await runUnits(units, CHECK_ALL_CONCURRENCY, ({ unit }) => {
        this.progress = { ...this.progress, done: this.progress.done + unit.weight };
        this.emit(unit.id.startsWith("account:") ? "accounts" : "connections");
      });
      this.lastFullRunAt = this.now().toISOString();
    } finally {
      this.progress = { ...this.progress, running: false };
      this.emit("accounts", "connections");
    }
  }

  /** Checks one row again and waits: an account or connection, or (any other row) the doctor checks. */
  async check(id: string): Promise<CommandOutput<"health.check">> {
    const unit = this.unitFor(id);
    if (unit === undefined) {
      this.toolCache.clear();
      await this.checks();
    } else {
      await unit.run().catch(() => undefined);
    }
    this.emit(
      id.startsWith("account:") ? "accounts" : id.startsWith("connection:") ? "connections" : "checks",
    );
    return { checkedAt: this.now().toISOString() };
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
