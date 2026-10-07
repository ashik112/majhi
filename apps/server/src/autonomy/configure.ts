import {
  AUTHORITY_LABEL,
  AUTHORITY_ROWS,
  type AutonomyFilePatchSchema,
  type AutonomyOrg,
  AutonomyOrgSchema,
  type AutonomyPatch,
  type AutonomySettings,
} from "@majhi/shared";
import type { z } from "zod";
import { authorityOf } from "../captain/levels.ts";
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
    const had: Record<string, unknown> = { ...(orgs[id] ?? {}) };
    // Some rows changed: write the new form from what holds now, and drop the old level, push and merge.
    if (change.authority !== undefined) {
      had.authority = { ...authorityOf(current, id), ...change.authority };
      delete had.level;
      delete had.push;
      delete had.merge;
    }
    // The Hold list changes class by class: the ones the patch names, the rest as they were.
    if (change.holds !== undefined && change.holds !== null) {
      had.holds = { ...(orgs[id]?.holds ?? {}), ...change.holds };
    }
    // The incident settings change field by field too.
    if (change.incident !== undefined && change.incident !== null) {
      had.incident = { ...(orgs[id]?.incident ?? {}), ...change.incident };
    }
    // Each field: absent keeps it, null clears it, a value sets it.
    for (const [key, value] of Object.entries(change)) {
      if (
        value === undefined ||
        key === "authority" ||
        ((key === "holds" || key === "incident") && value !== null)
      )
        continue;
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
  // The pick rule's workspace list moved to the per-workspace choice (5.18); it is not kept.
  const pick = { size: patch.pick?.size ?? current.pick.size };
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
  const own: string[] = [];
  if (patch.day !== undefined) parts.push(`the day cap to ${capText(patch.day)}`);
  for (const [id, change] of Object.entries(patch.orgs ?? {})) {
    const name = sections.orgs[id]?.name ?? (id === "private" ? "Private" : id);
    if (change === null) {
      own.push(`${name} back to the defaults`);
      continue;
    }
    for (const row of AUTHORITY_ROWS) {
      const choice = change.authority?.[row];
      if (choice !== undefined) {
        own.push(
          `${name}: "${AUTHORITY_LABEL[row]}" to ${choice === "decide" ? "Captain decides" : "Ask me"}`,
        );
      }
    }
    if (change.holds !== undefined) {
      own.push(change.holds === null ? `${name}: every hold on` : `${name}'s Hold list`);
    }
    if (change.cap === null) own.push(`no budget of its own for ${name}`);
    else if (change.cap !== undefined) own.push(`${name}'s daily budget to ${capText(change.cap)}`);
    const rules = (["ships", "hours", "freeze", "tz", "branches", "providers", "account"] as const).filter(
      (k) => change[k] !== undefined,
    );
    if (rules.length > 0) own.push(`${name}'s ${rules.map(ruleWord).join(", ")}`);
  }
  if (patch.floors?.window !== undefined) parts.push(`the 5-hour floor to ${patch.floors.window}%`);
  if (patch.floors?.weekly !== undefined) parts.push(`the weekly floor to ${patch.floors.weekly}%`);
  if (patch.summary_at !== undefined) parts.push(`the daily summary to ${patch.summary_at}`);
  if (patch.tz !== undefined) parts.push(`the time zone to ${patch.tz}`);
  if (patch.pick?.size !== undefined) parts.push(`the task size it takes to ${limitWord(patch.pick.size)}`);
  const lines = [
    ...(own.length === 0 ? [] : [`set ${own.join(", ")}`]),
    ...(parts.length === 0 ? [] : [`set autonomous mode's ${parts.join(", ")}`]),
  ];
  return lines.length === 0 ? "changed nothing in autonomous mode" : lines.join("; ");
}

function ruleWord(key: "ships" | "hours" | "freeze" | "tz" | "branches" | "providers" | "account"): string {
  switch (key) {
    case "ships":
      return "ship rules";
    case "hours":
      return "working hours";
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
