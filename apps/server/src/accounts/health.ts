import type { RuntimeOptions } from "@majhi/acp";
import type { AccountConfig, AccountModels, HealthCheck, HealthStep } from "@majhi/shared";
import { errorMessage, UserError } from "../errors.ts";
import type { AcpRuntime } from "../runtime.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { AccountCache, CachedAccount } from "./cache.ts";
import { accountRuntime, secretName } from "./homes.ts";
import type { AccountUsageReader } from "./usage.ts";

/** A probe younger than this is reused, so a screen that asks often does not start the CLI each time. */
export const PROBE_REUSE_MS = 30_000;

export interface ProbeDeps {
  majhiHome: string;
  runtime: AcpRuntime;
  options: RuntimeOptions;
  secrets: SecretStore;
  cache: AccountCache;
  /** Reads usage after a passing check of a login account. */
  usage?: AccountUsageReader;
  now?: () => number;
}

/** Runs and caches health checks and model reads. They spend no tokens. */
export class AccountProbes {
  private readonly inFlight = new Map<string, Promise<HealthCheck>>();
  private readonly now: () => number;

  constructor(private readonly deps: ProbeDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The last check, from memory or disk. Never starts a probe. */
  cached(id: string): Promise<CachedAccount> {
    return this.deps.cache.get(id);
  }

  /** Checks the account. Reuses a result under 30 seconds old unless `force`. */
  async check(id: string, config: AccountConfig, force = false): Promise<HealthCheck> {
    if (!force) {
      const { health } = await this.deps.cache.get(id);
      if (health !== undefined && this.now() - Date.parse(health.checkedAt) < PROBE_REUSE_MS) return health;
    }
    const running = this.inFlight.get(id);
    if (running !== undefined) return running;
    const started = this.probe(id, config).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, started);
    return started;
  }

  /** The account's models from the cache, or from a probe when there is none or `refresh` is set. */
  async models(id: string, config: AccountConfig, refresh = false): Promise<AccountModels> {
    if (!refresh) {
      const { models } = await this.deps.cache.get(id);
      if (models !== undefined) return models;
    }
    const health = await this.check(id, config, true);
    const { models } = await this.deps.cache.get(id);
    if (models !== undefined && health.ok) return models;
    const failed = health.steps.find((s) => !s.ok);
    throw new UserError(
      `Cannot read the models of ${id}: ${failed === undefined ? "the account offered none" : `${failed.name}: ${failed.detail}`}`,
      409,
    );
  }

  private async probe(id: string, config: AccountConfig): Promise<HealthCheck> {
    const started = this.now();
    const fail = (step: HealthStep): HealthCheck => ({
      ok: false,
      checkedAt: new Date(this.now()).toISOString(),
      durationMs: this.now() - started,
      steps: [step],
    });

    let health: HealthCheck;
    let extra: { signedInAs?: string | undefined; models?: AccountModels | undefined } = {};
    try {
      const apiKey = await this.apiKey(config);
      if (apiKey.error !== undefined) {
        health = fail({ name: "auth", ok: false, detail: apiKey.error });
      } else {
        const account = accountRuntime(this.deps.majhiHome, id, config, apiKey.value);
        await this.deps.runtime.prepareHome(account);
        const probe = await this.deps.runtime.probeAccount(account, this.deps.options);
        health = probe.health;
        extra = {
          signedInAs: probe.signedInAs,
          models: probe.models === undefined ? undefined : { ...probe.models, account: id },
        };
      }
    } catch (err) {
      health = fail({ name: "cli", ok: false, detail: errorMessage(err) });
    }
    await this.deps.cache.setHealth(id, health, extra);
    // In the background: the check must not wait for the usage read.
    if (health.ok) void this.deps.usage?.read(id, config);
    return health;
  }

  /** Decrypts the API key just before a probe. `error` says why there is none. */
  private async apiKey(config: AccountConfig): Promise<{ value?: string; error?: string }> {
    if (config.auth !== "api-key" || config.key === undefined) return {};
    if (!(await this.deps.secrets.available())) return { error: "Secrets are not set up: run make up" };
    const value = await this.deps.secrets.get(secretName(config.key));
    if (value === undefined)
      return { error: "The API key is missing from secrets.age. Add the account again." };
    return { value };
  }
}
