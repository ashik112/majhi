import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AccountModels, AccountModelsSchema, type HealthCheck, HealthCheckSchema } from "@majhi/shared";
import { z } from "zod";
import { errorCode } from "../errors.ts";

const CachedAccountSchema = z.object({
  health: HealthCheckSchema.optional(),
  signedInAs: z.string().optional(),
  models: AccountModelsSchema.optional(),
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

  /** Stores a health result. `models` and `signedInAs` are kept from before when the new check has none. */
  async setHealth(
    id: string,
    health: HealthCheck,
    extra: { signedInAs?: string | undefined; models?: AccountModels | undefined },
  ): Promise<CachedAccount> {
    const before = await this.get(id);
    const next: CachedAccount = { health };
    if (extra.signedInAs !== undefined) next.signedInAs = extra.signedInAs;
    const models = extra.models ?? before.models;
    if (models !== undefined) next.models = models;
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
