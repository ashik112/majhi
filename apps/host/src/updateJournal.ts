import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isMissing, removeDurableFile, writeDurableJson } from "./durableFile.ts";
import { RuntimeFilesSchema } from "./releasePackage.ts";

const FILE = "update-transaction.json";
export const UpdateJournalSchema = z.object({
  version: z.literal(1),
  phase: z.enum(["prepared", "snapshotting", "starting", "committed"]),
  previous: z.array(
    z.object({
      image: z.enum(["majhi-server:dev", "majhi-runner:dev", "majhi-laya:dev"]),
      id: z.string().min(1),
    }),
  ),
  mounts: z.string().optional(),
  moved: z
    .object({
      from: z.string(),
      to: z.string(),
      head: z.string(),
      dotenv: z.string(),
      files: RuntimeFilesSchema.optional(),
    })
    .optional(),
});
export type UpdateJournal = z.infer<typeof UpdateJournalSchema>;
export async function readUpdateJournal(home: string): Promise<UpdateJournal | undefined> {
  try {
    return UpdateJournalSchema.parse(JSON.parse(await readFile(join(home, FILE), "utf8")));
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
}
export async function writeUpdateJournal(home: string, journal: UpdateJournal): Promise<void> {
  await writeDurableJson(join(home, FILE), UpdateJournalSchema.parse(journal));
}
export async function clearUpdateJournal(home: string): Promise<void> {
  await removeDurableFile(join(home, FILE));
}
