import { readFile } from "node:fs/promises";
import { type AutonomyOrg, type AutonomySettings, carriedOver, PRIVATE } from "@majhi/shared";
import { isMap, parseDocument } from "yaml";
import { levelOf } from "../captain/levels.ts";
import { editConfig } from "./write.ts";

/**
 * The org's own merge switch (`orgs.<id>.merge`: never, approve, auto-if-green) folds into the workspace's
 * authority level, the one place that says who merges. The switch and what read it are gone; this moves what
 * the owner had set, once.
 *
 * | old value     | the old switch let the captain...                    | Level after                    |
 * | never         | not merge merge requests                             | as it was                      |
 * | approve       | merge them only when told (the owner's click)        | as it was                      |
 * | auto-if-green | merge them by itself once CI passes                  | Full (merges into main)        |
 */
export type OldMergePolicy = "never" | "approve" | "auto-if-green";

/** The old value as the file had it. Anything else was never valid and counted as `never`. */
export function oldPolicyOf(value: unknown): OldMergePolicy {
  return value === "approve" || value === "auto-if-green" ? value : "never";
}

/** The orgs of majhi.yaml that still carry the old switch, with its value. */
export async function orgsWithMergeSwitch(file: string): Promise<{ id: string; policy: OldMergePolicy }[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  const doc = parseDocument(text);
  const orgs = doc.get("orgs", true);
  if (!isMap(orgs)) return [];
  const found: { id: string; policy: OldMergePolicy }[] = [];
  for (const pair of orgs.items) {
    const org = pair.value;
    if (!isMap(org) || !org.has("merge")) continue;
    found.push({ id: String(pair.key), policy: oldPolicyOf(org.get("merge")) });
  }
  return found;
}

/** The autonomy `orgs` after the fold: only the orgs whose level changes get a new entry. */
export function foldedOrgs(
  autonomy: Pick<AutonomySettings, "orgs">,
  found: readonly { id: string; policy: OldMergePolicy }[],
): Record<string, AutonomyOrg> | undefined {
  const orgs: Record<string, AutonomyOrg> = { ...autonomy.orgs };
  let changed = false;
  for (const { id, policy } of found) {
    if (policy !== "auto-if-green" || levelOf(autonomy, id) === "full") continue;
    orgs[id] = { ...carriedOver(orgs[id], id === PRIVATE), level: "full" };
    changed = true;
  }
  return changed ? orgs : undefined;
}

/** Removes `orgs.<id>.merge` from majhi.yaml for every org that has it. */
export function removeOrgMergeSwitches(file: string, ids: readonly string[]): Promise<void> {
  return editConfig(file, (doc) => {
    for (const id of ids) doc.deleteIn(["orgs", id, "merge"]);
  });
}
