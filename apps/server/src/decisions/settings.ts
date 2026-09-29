import { readFile } from "node:fs/promises";
import { DecisionPatchSchema, type DecisionSettings, DecisionSettingsSchema } from "@majhi/shared";
import { parseDocument } from "yaml";

/** `decisions:` from majhi.yaml with defaults filled in. A missing file or a bad section gives the defaults. */
export async function readDecisionSettings(file: string): Promise<DecisionSettings> {
  try {
    const doc = parseDocument(await readFile(file, "utf8"));
    const raw: unknown = doc.toJS() ?? {};
    const section =
      typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).decisions : undefined;
    const patch = DecisionPatchSchema.safeParse(section ?? {});
    return DecisionSettingsSchema.parse(patch.success ? patch.data : {});
  } catch {
    return DecisionSettingsSchema.parse({});
  }
}
