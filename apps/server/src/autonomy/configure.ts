import type { AutonomyFilePatchSchema, AutonomyOrg, AutonomyPatch, AutonomySettings } from "@majhi/shared";
import type { z } from "zod";
import type { ConfigSections } from "../config/sections.ts";
import { limitWord } from "./sizes.ts";
import { capText } from "./spend.ts";

/**
 * `autonomy.configure` (PRV-74): an org entry merges into the org's current one and `null` removes
 * it (or its cap); the floors merge; the day cap changes but never goes away. Pure.
 */
export function mergePatch(current: AutonomySettings, patch: AutonomyPatch): AutonomySettings {
  const orgs: Record<string, AutonomyOrg> = { ...current.orgs };
  for (const [id, change] of Object.entries(patch.orgs ?? {})) {
    if (change === null) {
      delete orgs[id];
      continue;
    }
    const had = orgs[id] ?? { push: false, merge: false };
    const cap = change.cap === undefined ? had.cap : (change.cap ?? undefined);
    const next: AutonomyOrg = {
      ...(cap === undefined ? {} : { cap }),
      push: change.push ?? had.push,
      merge: change.merge ?? had.merge,
    };
    // An entry that says only the defaults is no entry.
    if (next.cap === undefined && !next.push && !next.merge) delete orgs[id];
    else orgs[id] = next;
  }
  const tz = patch.tz ?? current.tz;
  const pickOrgs = patch.pick?.orgs === undefined ? current.pick.orgs : (patch.pick.orgs ?? undefined);
  const pick = {
    size: patch.pick?.size ?? current.pick.size,
    ...(pickOrgs === undefined ? {} : { orgs: [...new Set(pickOrgs)] }),
  };
  return {
    ...current,
    pick,
    day: patch.day ?? current.day,
    orgs,
    floors: {
      window: patch.floors?.window ?? current.floors.window,
      weekly: patch.floors?.weekly ?? current.floors.weekly,
    },
    summary_at: patch.summary_at ?? current.summary_at,
    ...(tz === undefined ? {} : { tz }),
  };
}

/** The keys of the `autonomy` section to write: only the ones the patch touches, each whole. */
export function toFile(
  next: AutonomySettings,
  patch: AutonomyPatch,
): z.infer<typeof AutonomyFilePatchSchema> {
  return {
    ...(patch.day === undefined ? {} : { day: next.day }),
    ...(patch.orgs === undefined ? {} : { orgs: next.orgs }),
    ...(patch.floors === undefined ? {} : { floors: next.floors }),
    ...(patch.summary_at === undefined ? {} : { summary_at: next.summary_at }),
    ...(patch.tz === undefined ? {} : { tz: next.tz }),
    ...(patch.pick === undefined ? {} : { pick: next.pick }),
  };
}

/** The config history's line: "set autonomous mode's day cap to $30.00, Acme's cap to $5.00". */
export function describePatch(patch: AutonomyPatch, sections: Pick<ConfigSections, "orgs">): string {
  const parts: string[] = [];
  if (patch.day !== undefined) parts.push(`the day cap to ${capText(patch.day)}`);
  for (const [id, change] of Object.entries(patch.orgs ?? {})) {
    const name = sections.orgs[id]?.name ?? id;
    if (change === null) {
      parts.push(`${name} back to the defaults`);
      continue;
    }
    if (change.cap === null) parts.push(`no cap of its own for ${name}`);
    else if (change.cap !== undefined) parts.push(`${name}'s cap to ${capText(change.cap)}`);
    if (change.push !== undefined) parts.push(`pushing for ${name} ${change.push ? "on" : "off"}`);
    if (change.merge !== undefined) parts.push(`merging for ${name} ${change.merge ? "on" : "off"}`);
  }
  if (patch.floors?.window !== undefined) parts.push(`the 5-hour floor to ${patch.floors.window}%`);
  if (patch.floors?.weekly !== undefined) parts.push(`the weekly floor to ${patch.floors.weekly}%`);
  if (patch.summary_at !== undefined) parts.push(`the daily summary to ${patch.summary_at}`);
  if (patch.tz !== undefined) parts.push(`the time zone to ${patch.tz}`);
  if (patch.pick?.size !== undefined) parts.push(`the task size it takes to ${limitWord(patch.pick.size)}`);
  if (patch.pick?.orgs === null) parts.push("the orgs it works in to all");
  else if (patch.pick?.orgs !== undefined) {
    const names = patch.pick.orgs.map((id) => sections.orgs[id]?.name ?? id);
    parts.push(`the orgs it works in to ${names.length === 0 ? "none" : names.join(", ")}`);
  }
  return parts.length === 0
    ? "changed nothing in autonomous mode"
    : `set autonomous mode's ${parts.join(", ")}`;
}
