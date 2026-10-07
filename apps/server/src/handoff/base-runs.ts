import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../fs.ts";

/**
 * What a check did on a base commit, kept on disk by a key made from the base commit, the check's
 * command and its environment. The same base and check are run once, whoever's task asks. A file that
 * does not read is a miss: the check runs again.
 */
const BaseRunSchema = z.object({
  passed: z.boolean(),
  problems: z.array(z.string()).optional(),
});

export function baseRunStore(dir: string) {
  const file = (key: string) => join(dir, `${key}.json`);
  return {
    async get(key: string): Promise<z.infer<typeof BaseRunSchema> | undefined> {
      try {
        const parsed = BaseRunSchema.safeParse(JSON.parse(await readFile(file(key), "utf8")));
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    },
    async put(key: string, run: z.infer<typeof BaseRunSchema>): Promise<void> {
      await mkdir(dir, { recursive: true });
      await writeFileAtomic(file(key), JSON.stringify(run));
    },
  };
}
