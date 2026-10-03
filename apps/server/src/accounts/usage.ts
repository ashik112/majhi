import { type RuntimeOptions, SignInExpired } from "@majhi/acp";
import type { AccountConfig, AccountUsage } from "@majhi/shared";
import { errorMessage } from "../errors.ts";
import type { AcpRuntime } from "../runtime.ts";
import type { AccountCache } from "./cache.ts";
import { accountRuntime } from "./homes.ts";

/** How often the background sweep reads every signed-in account's usage. */
export const USAGE_SWEEP_MS = 10 * 60_000;

export interface UsageDeps {
  majhiHome: string;
  runtime: AcpRuntime;
  options: RuntimeOptions;
  cache: AccountCache;
  /** Told when the numbers or the error of an account changed, so open screens refetch. */
  onChanged: () => void;
  /** A read found the sign-in dead: told after the account was marked `needs-login`, when it was not before. */
  onSignedOut?: (id: string, detail: string) => void;
  now?: () => number;
}

/**
 * What a read says about the sign-in: `ok` when the CLI read the plan with its token, `expired`
 * when it could not use the token at all, `unknown` when the read failed for another reason.
 */
export type SignInState = { state: "ok" } | { state: "expired"; detail: string } | { state: "unknown" };

interface UsageRead {
  usage: AccountUsage | null;
  signIn: SignInState;
}

/** What screens compare: everything but the read time. */
function signature(usage: AccountUsage | undefined): string {
  return JSON.stringify(usage === undefined ? null : { ...usage, updatedAt: undefined });
}

/**
 * Reads and caches the 5-hour and weekly usage of login accounts. Reads spend
 * no model tokens. A failed read keeps the last good numbers and sets `error`;
 * it never throws. It changes the account's health in one case only: the CLI
 * could not use its sign-in at all, so the account is marked `needs-login`.
 */
export class AccountUsageReader {
  private readonly inFlight = new Map<string, Promise<UsageRead>>();
  private readonly now: () => number;

  constructor(private readonly deps: UsageDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The cached usage, or a read when there is none or `refresh` is set. Null for API-key accounts. */
  async get(id: string, config: AccountConfig, refresh = false): Promise<AccountUsage | null> {
    if (config.auth === "api-key") return null;
    if (!refresh) {
      const { usage } = await this.deps.cache.get(id);
      if (usage !== undefined) return usage;
    }
    // An explicit refresh must not be answered by a read that began before it, so it waits its turn.
    await this.inFlight.get(id);
    return this.read(id, config);
  }

  /** Reads now. Joins a read already running for the account. Never rejects. */
  async read(id: string, config: AccountConfig): Promise<AccountUsage | null> {
    return (await this.readWithSignIn(id, config)).usage;
  }

  /**
   * Reads now and says whether the sign-in worked: the health check's real sign-in test, since the
   * CLI's own status command only looks for credentials. Never rejects.
   */
  async signIn(id: string, config: AccountConfig): Promise<SignInState> {
    return (await this.readWithSignIn(id, config)).signIn;
  }

  private readWithSignIn(id: string, config: AccountConfig): Promise<UsageRead> {
    if (config.auth === "api-key") return Promise.resolve({ usage: null, signIn: { state: "unknown" } });
    const running = this.inFlight.get(id);
    if (running !== undefined) return running;
    const started = this.readNow(id, config).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, started);
    return started;
  }

  private async readNow(id: string, config: AccountConfig): Promise<UsageRead> {
    const before = (await this.deps.cache.get(id)).usage;
    let next: AccountUsage | undefined;
    let signIn: SignInState = { state: "ok" };
    try {
      const account = accountRuntime(this.deps.majhiHome, id, config);
      next = await this.deps.runtime.readUsage(account, this.deps.options);
      if (next === undefined) return { usage: before ?? null, signIn: { state: "unknown" } };
    } catch (err) {
      const stub: AccountUsage = {
        models: [],
        estimated: false,
        updatedAt: new Date(this.now()).toISOString(),
      };
      next = { ...(before ?? stub), error: errorMessage(err) };
      signIn =
        err instanceof SignInExpired ? { state: "expired", detail: err.message } : { state: "unknown" };
    }
    await this.deps.cache.setUsage(id, next);
    if (signIn.state === "expired") {
      const fresh = await this.deps.cache.markSignedOut(id, signIn.detail, new Date(this.now()));
      if (fresh) this.deps.onSignedOut?.(id, signIn.detail);
      this.deps.onChanged();
    } else if (signature(before) !== signature(next)) this.deps.onChanged();
    return { usage: next, signIn };
  }
}

export interface SweepDeps {
  reader: AccountUsageReader;
  /** Login accounts whose last health check passed. */
  candidates: () => Promise<{ id: string; config: AccountConfig }[]>;
  intervalMs?: number;
}

/** Reads usage for every candidate account every 10 minutes, one at a time. A sweep is skipped while the previous one runs. */
export class UsageSweeper {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly deps: SweepDeps) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.sweep(), this.deps.intervalMs ?? USAGE_SWEEP_MS);
    this.timer.unref();
    void this.sweep();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One sweep. Returns false when it was skipped. */
  async sweep(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      for (const { id, config } of await this.deps.candidates()) {
        await this.deps.reader.read(id, config);
      }
    } catch (err) {
      console.error(`usage sweep failed: ${errorMessage(err)}`);
    } finally {
      this.running = false;
    }
    return true;
  }
}
