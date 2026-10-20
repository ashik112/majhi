import {
  type AutonomyFilePatchSchema,
  type AutonomyOrg,
  AutonomyOrgSchema,
  type AutonomyPatch,
  type AutonomySettings,
} from "@majhi/shared";
import type { z } from "zod";
import type { ConfigSections } from "../config/sections.ts";
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
    const had: Record<string, unknown> = { ...(orgs[id] ?? {}) };
    // The Hold list changes class by class: the ones the patch names, the rest as they were.
    if (change.holds !== undefined && change.holds !== null) {
      had.holds = { ...(orgs[id]?.holds ?? {}), ...change.holds };
    }
    // The incident settings change field by field too. "Back to the defaults" keeps the two switches only the
    // owner sets (`authority.set`): they are not this command's to clear.
    if (change.incident !== undefined) {
      const kept = { fix: orgs[id]?.incident?.fix, clientUpdate: orgs[id]?.incident?.clientUpdate };
      const own = change.incident === null ? kept : { ...(orgs[id]?.incident ?? {}), ...change.incident };
      const fields = Object.entries(own).filter(([, v]) => v !== undefined);
      if (fields.length === 0) delete had.incident;
      else had.incident = Object.fromEntries(fields);
    }
    // Each field: absent keeps it, null clears it, a value sets it.
    for (const [key, value] of Object.entries(change)) {
      if (value === undefined || key === "incident" || (key === "holds" && value !== null)) continue;
      if (value === null) delete had[key];
      else had[key] = value;
    }
    const next = AutonomyOrgSchema.parse(had);
    // An entry that says only the defaults is no entry.
    const meaningful = Object.values(next).some((v) => v !== undefined);
    if (meaningful) orgs[id] = next;
    else delete orgs[id];
  }
  const tz = patch.tz ?? current.tz;
  return {
    ...current,
    day: patch.day ?? current.day,
    orgs,
    floors: {
      window: patch.floors?.window ?? current.floors.window,
      weekly: patch.floors?.weekly ?? current.floors.weekly,
    },
    brief_at: patch.brief_at ?? current.brief_at,
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
    ...(patch.brief_at === undefined ? {} : { brief_at: next.brief_at }),
    ...(patch.tz === undefined ? {} : { tz: next.tz }),
  };
}

/** The config history's line: "set autonomous mode's day cap to $30.00, Acme's cap to $5.00". */
export function describePatch(patch: AutonomyPatch, sections: Pick<ConfigSections, "orgs">): string {
  const parts: string[] = [];
  const own: string[] = [];
  if (patch.day !== undefined) parts.push(`the day cap to ${capText(patch.day)}`);
  for (const [id, change] of Object.entries(patch.orgs ?? {})) {
    const name = sections.orgs[id]?.name ?? (id === "private" ? "Private" : id);
    if (change === null) {
      own.push(`${name} back to the defaults`);
      continue;
    }
    if (change.holds !== undefined) {
      own.push(change.holds === null ? `${name}: every hold on` : `${name}'s Hold list`);
    }
    if (change.cap === null) own.push(`no budget of its own for ${name}`);
    else if (change.cap !== undefined) own.push(`${name}'s daily budget to ${capText(change.cap)}`);
    const rules = (["freeze", "tz", "branches", "providers", "account"] as const).filter(
      (k) => change[k] !== undefined,
    );
    if (rules.length > 0) own.push(`${name}'s ${rules.map(ruleWord).join(", ")}`);
  }
  if (patch.floors?.window !== undefined) parts.push(`the 5-hour floor to ${patch.floors.window}%`);
  if (patch.floors?.weekly !== undefined) parts.push(`the weekly floor to ${patch.floors.weekly}%`);
  if (patch.brief_at !== undefined) parts.push(`the morning brief to ${patch.brief_at}`);
  if (patch.tz !== undefined) parts.push(`the time zone to ${patch.tz}`);
  const lines = [
    ...(own.length === 0 ? [] : [`set ${own.join(", ")}`]),
    ...(parts.length === 0 ? [] : [`set Autonomous's ${parts.join(", ")}`]),
  ];
  return lines.length === 0 ? "changed nothing in Autonomous" : lines.join("; ");
}

function ruleWord(key: "freeze" | "tz" | "branches" | "providers" | "account"): string {
  switch (key) {
    case "freeze":
      return "freeze dates";
    case "tz":
      return "time zone";
    case "branches":
      return "branches to ship to";
    case "providers":
      return "AI providers";
    case "account":
      return "paying account";
  }
}
