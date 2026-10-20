import { copyFile, readFile, realpath } from "node:fs/promises";
import { access } from "node:fs/promises";
import { isMap, parseDocument } from "yaml";
import { errorCode } from "../errors.ts";
import { editConfig } from "./write.ts";

/**
 * Autonomous keeps its own rules (docs/briefs/captain.md): the task size it takes (`autonomy.pick`), the tasks it
 * works on at once per workspace (`autonomy.orgs.<id>.tasksAtOnce`) and its working hours (`autonomy.orgs.<id>.hours`)
 * are rules it keeps by itself now. This reads which of them a majhi.yaml still holds.
 */
const ORG_KEYS = ["tasksAtOnce", "hours"] as const;

/** The legacy keys a majhi.yaml holds, as paths ("autonomy.pick", "autonomy.orgs.acme.hours"). Empty for a clean file. */
export async function legacyAutonomousKeys(file: string): Promise<string[]> {
  const text = await readFile(file, "utf8").catch((err: unknown) => {
    if (errorCode(err) === "ENOENT") return "";
    throw err;
  });
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return [];
  const found: string[] = [];
  if (doc.hasIn(["autonomy", "pick"])) found.push("autonomy.pick");
  const orgs = doc.getIn(["autonomy", "orgs"], true);
  if (isMap(orgs)) {
    for (const pair of orgs.items) {
      const id = String((pair.key as { value?: unknown } | null)?.value ?? "");
      for (const key of ORG_KEYS) {
        if (doc.hasIn(["autonomy", "orgs", id, key])) found.push(`autonomy.orgs.${id}.${key}`);
      }
    }
  }
  return found;
}

/**
 * Takes the legacy keys out of majhi.yaml. The file is written through a temp file and a rename, comments and the
 * other keys stay, and a copy of the file as it was is kept beside it (`majhi.yaml.before-autonomous`, once) on top
 * of the config history's commit, which Undo reverts.
 */
export async function dropLegacyAutonomous(file: string): Promise<void> {
  const copy = `${await realpath(file).catch(() => file)}.before-autonomous`;
  const kept = await access(copy).then(
    () => true,
    () => false,
  );
  if (!kept) await copyFile(file, copy).catch(() => undefined);
  await editConfig(file, (doc) => {
    doc.deleteIn(["autonomy", "pick"]);
    const orgs = doc.getIn(["autonomy", "orgs"], true);
    if (!isMap(orgs)) return;
    for (const pair of orgs.items) {
      const id = String((pair.key as { value?: unknown } | null)?.value ?? "");
      for (const key of ORG_KEYS) doc.deleteIn(["autonomy", "orgs", id, key]);
    }
  });
}
