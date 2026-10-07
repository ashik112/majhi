import { readFile } from "node:fs/promises";
import type { Authority, AutonomyOrg, AutonomySettings } from "@majhi/shared";
import { isMap, parseDocument } from "yaml";
import { authorityOf } from "../captain/levels.ts";
import { editConfig } from "./write.ts";

/**
 * The org's own merge switch (`orgs.<id>.merge`: never, approve, auto-if-green) folds into the Merge row of
 * the authority table, which is the one place that says who merges (ship rules, phase B). The switch and
 * what read it are gone; this moves what the owner had set, once.
 *
 * What each old value meant for the captain, and what it becomes:
 *
 * | old value     | the old switch let the captain...                    | Merge row after                |
 * | never         | not merge merge requests                             | as it was                      |
 * | approve       | merge them only when told (the owner's click)        | as it was                      |
 * | auto-if-green | merge them by itself once CI passes, row or no row   | Captain                        |
 *
 * `never` and `approve` leave merge requests to the owner's click and the row decides the rest, so the
 * row stays. Only `auto-if-green` said "majhi merges by itself", which is what Captain says now.
 */
export type OldMergePolicy = "never" | "approve" | "auto-if-green";

export function foldedMergeRow(policy: OldMergePolicy, row: Authority["merge"]): Authority["merge"] {
  return policy === "auto-if-green" ? "decide" : row;
}

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

/** The autonomy `orgs` after the fold: only the orgs whose Merge row changes get a new entry. */
export function foldedOrgs(
  autonomy: Pick<AutonomySettings, "orgs">,
  found: readonly { id: string; policy: OldMergePolicy }[],
): Record<string, AutonomyOrg> | undefined {
  const orgs: Record<string, AutonomyOrg> = { ...autonomy.orgs };
  let changed = false;
  for (const { id, policy } of found) {
    const rows = authorityOf(autonomy, id);
    const merge = foldedMergeRow(policy, rows.merge);
    if (merge === rows.merge) continue;
    // Writing the rows drops the old level, push and merge flags they came from, as saving from the page does.
    const { level: _level, push: _push, merge: _merge, ...rest } = orgs[id] ?? {};
    orgs[id] = { ...rest, authority: { ...rows, merge } };
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
