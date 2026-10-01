import { readFile } from "node:fs/promises";
import {
  CleanupPatchSchema,
  CommitsPatchSchema,
  ContainersFilePatchSchema,
  ContextPatchSchema,
  DecisionPatchSchema,
  EditorPatchSchema,
  LimitsPatchSchema,
  MemoryPatchSchema,
  PolicyPatchSchema,
  ResumePatchSchema,
  RoomPatchSchema,
  type Settings,
  SettingsSchema,
} from "@majhi/shared";
import { parseDocument } from "yaml";
import { z } from "zod";
import { errorCode, formatIssues } from "../errors.ts";
import { ConfigConflictError } from "./write.ts";

/** Only the fields set in majhi.yaml, or in a `settings.set` / `policy.set` call. */
export const SettingsPatchSchema = z.object({
  context: ContextPatchSchema.optional(),
  limits: LimitsPatchSchema.optional(),
  resume: ResumePatchSchema.optional(),
  commits: CommitsPatchSchema.optional(),
  rooms: RoomPatchSchema.optional(),
  policy: PolicyPatchSchema.optional(),
  decisions: DecisionPatchSchema.optional(),
  memory: MemoryPatchSchema.optional(),
  editor: EditorPatchSchema.optional(),
  cleanup: CleanupPatchSchema.optional(),
  containers: ContainersFilePatchSchema.optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** Defaults filled in for whatever the sections leave out. */
export function mergeSettings(raw: SettingsPatch): Settings {
  return SettingsSchema.parse({
    context: raw.context ?? {},
    limits: raw.limits ?? {},
    resume: raw.resume ?? {},
    commits: raw.commits ?? {},
    rooms: raw.rooms ?? {},
    policy: raw.policy ?? {},
    memory: raw.memory ?? {},
    editor: raw.editor ?? {},
    cleanup: raw.cleanup ?? {},
    containers: raw.containers ?? {},
  });
}

/** Reads the settings sections of majhi.yaml. A missing file or section means defaults. */
export async function readSettings(file: string): Promise<Settings> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return mergeSettings({});
    throw err;
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new ConfigConflictError(
      "majhi.yaml has YAML errors. Fix them by hand first.",
      doc.errors.map((e) => e.message.split("\n", 1)[0] ?? e.message),
    );
  }
  const raw: unknown = doc.toJS() ?? {};
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const parsed = SettingsPatchSchema.safeParse({
    context: record.context,
    limits: record.limits,
    resume: record.resume,
    commits: record.commits,
    rooms: record.rooms,
    policy: record.policy,
    memory: record.memory,
    editor: record.editor,
    cleanup: record.cleanup,
    containers: record.containers,
  });
  if (!parsed.success) {
    throw new ConfigConflictError("majhi.yaml has invalid settings.", formatIssues(parsed.error));
  }
  return mergeSettings(parsed.data);
}
