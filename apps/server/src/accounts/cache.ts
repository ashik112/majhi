import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AccountLimit,
  AccountLimitSchema,
  type AccountModels,
  AccountModelsSchema,
  type AccountUsage,
  AccountUsageSchema,
  type HealthCheck,
  HealthCheckSchema,
} from "@majhi/shared";
import { z } from "zod";
import { errorCode } from "../errors.ts";
import { statusFromHealth } from "./status.ts";

const CachedAccountSchema = z.object({
  health: HealthCheckSchema.optional(),
  signedInAs: z.string().optional(),
  models: AccountModelsSchema.optional(),
  usage: AccountUsageSchema.optional(),
  /**
   * A run or a usage read found the sign-in dead (the token expired and could not be refreshed).
   * The account stays `needs-login` until a check confirms the sign-in works again.
   */
  signInFailed: z.object({ at: z.string(), detail: z.string() }).optional(),
  /** A run hit the account's usage or rate limit. Holds until `until`, then it is cleared (5.7). */
  limit: AccountLimitSchema.optional(),
});
export type CachedAccount = z.infer<typeof CachedAccountSchema>;

/**
 * Last health check and model list per account. Kept in memory and in
 * `<majhi home>/cache/accounts/<id>.json` (git-ignored) so they survive a restart.
 */
export class AccountCache {
  private readonly dir: string;
  private readonly memory = new Map<string, CachedAccount>();

  constructor(majhiHome: string) {
    this.dir = join(majhiHome, "cache", "accounts");
  }

  async get(id: string): Promise<CachedAccount> {
    const hit = this.memory.get(id);
    if (hit !== undefined) return hit;
    const loaded = await this.readDisk(id);
    this.memory.set(id, loaded);
    return loaded;
  }

  /**
   * Stores a health result. `models` and `signedInAs` are kept from before when the new check has
   * none. A passing check clears `signInFailed`; a failing one keeps it, or sets the one given.
   */
  async setHealth(
    id: string,
    health: HealthCheck,
    extra: {
      signedInAs?: string | undefined;
      models?: AccountModels | undefined;
      signInFailed?: CachedAccount["signInFailed"];
    },
  ): Promise<CachedAccount> {
    const before = await this.get(id);
    const next: CachedAccount = { health };
    if (before.usage !== undefined) next.usage = before.usage;
    if (before.limit !== undefined) next.limit = before.limit;
    const failed = health.ok ? undefined : (extra.signInFailed ?? before.signInFailed);
    if (failed !== undefined) next.signInFailed = failed;
    if (extra.signedInAs !== undefined) next.signedInAs = extra.signedInAs;
    const models = extra.models ?? before.models;
    if (models !== undefined) next.models = models;
    this.memory.set(id, next);
    await this.writeDisk(id, next);
    return next;
  }

  /**
   * The sign-in no longer works (a run failed on auth, or a usage read found no usable token): the
   * account becomes `needs-login` now, without waiting for a check. True when it was not already.
   */
  async markSignedOut(id: string, detail: string, at: Date): Promise<boolean> {
    const before = await this.get(id);
    const was = statusFromHealth(before.health) === "needs-login";
    const health: HealthCheck = {
      ok: false,
      checkedAt: at.toISOString(),
      durationMs: 0,
      steps: [{ name: "auth", ok: false, detail }],
    };
    await this.setHealth(id, health, { signInFailed: { at: at.toISOString(), detail } });
    return !was;
  }

  /** Sets or, with undefined, clears the account's limit mark. Health, models and usage stay as they were. */
  async setLimit(id: string, limit: AccountLimit | undefined): Promise<CachedAccount> {
    const { limit: _before, ...rest } = await this.get(id);
    const next: CachedAccount = limit === undefined ? rest : { ...rest, limit };
    this.memory.set(id, next);
    await this.writeDisk(id, next);
    return next;
  }

  /** Stores the account's usage. Health and models stay as they were. */
  async setUsage(id: string, usage: AccountUsage): Promise<CachedAccount> {
    const next: CachedAccount = { ...(await this.get(id)), usage };
    this.memory.set(id, next);
    await this.writeDisk(id, next);
    return next;
  }

  async remove(id: string): Promise<void> {
    this.memory.delete(id);
    await rm(join(this.dir, `${id}.json`), { force: true });
  }

  private async readDisk(id: string): Promise<CachedAccount> {
    try {
      const text = await readFile(join(this.dir, `${id}.json`), "utf8");
      const parsed = CachedAccountSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : {};
    } catch (err) {
      // A missing or damaged cache only means the next check runs again.
      if (errorCode(err) === "ENOENT" || err instanceof SyntaxError) return {};
      throw err;
    }
  }

  private async writeDisk(id: string, value: CachedAccount): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, `${id}.json`);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(value));
    await rename(temp, file);
  }
}
