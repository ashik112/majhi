import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SqlNameSchema } from "@majhi/shared";
import { z } from "zod";
import { writeFileAtomic } from "../fs.ts";

/**
 * Branch databases (docs/briefs/workflow-reset.md, step 2). A task that changes the schema of a project's
 * database works on a copy of it, `CREATE DATABASE <task> TEMPLATE <dev>`, and the copy is dropped when the
 * task closes. The service that holds the copy may be stopped by then (its data is in a volume, the server
 * is not), so every copy is written down here until it is dropped: the next start of that service finishes
 * the job.
 */

const BranchSchema = z.object({
  /** The project environment (`majhi.project`). */
  env: z.string(),
  /** The Postgres service, by the name it was started under. */
  service: z.string(),
  /** The role to connect as: the service's POSTGRES_USER. */
  user: SqlNameSchema,
  /** The copy: the task's own database. */
  database: SqlNameSchema,
  template: SqlNameSchema,
  /** The task that made it. */
  task: z.string(),
});
export type Branch = z.infer<typeof BranchSchema>;

const FileSchema = z.object({ branches: z.array(BranchSchema) });

/** The database name a task's copy gets: its key, lowercase, `_` for `-`. `ACM-1` is `acm_1`. */
export const branchName = (task: string): string => task.toLowerCase().replaceAll("-", "_");

export class BranchLedger {
  private readonly file: string;

  constructor(majhiHome: string) {
    this.file = join(majhiHome, "cache", "branch-dbs.json");
  }

  async list(): Promise<Branch[]> {
    try {
      const parsed = FileSchema.safeParse(JSON.parse(await readFile(this.file, "utf8")));
      return parsed.success ? parsed.data.branches : [];
    } catch {
      return [];
    }
  }

  private async save(branches: Branch[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFileAtomic(this.file, `${JSON.stringify({ branches })}\n`);
  }

  /** Writes a copy down. Writing the same copy again changes nothing. */
  async add(branch: Branch): Promise<void> {
    const rest = (await this.list()).filter((b) => !(b.env === branch.env && b.database === branch.database));
    await this.save([...rest, branch]);
  }

  async remove(branch: Branch): Promise<void> {
    await this.save(
      (await this.list()).filter((b) => !(b.env === branch.env && b.database === branch.database)),
    );
  }
}
