import {
  type AutonomyMode,
  type AutonomyOrg,
  type AutonomySettings,
  type CaptainChore,
  CaptainChoreSchema,
  type CaptainLevel,
  PRIVATE,
} from "@majhi/shared";

/**
 * How much the captain does in a workspace (SPEC 5.18). Pure: the defaults, what "Runs it" means while
 * autonomous mode is off, which chores a level runs, and the move from the old pick rule.
 */

/** The choice as saved, or its default: "Keeps things tidy" for Private, "Only when I ask" elsewhere. */
export function levelOf(settings: Pick<AutonomySettings, "orgs">, org: string): CaptainLevel {
  return settings.orgs[org]?.level ?? defaultLevel(org);
}

export function defaultLevel(org: string): CaptainLevel {
  return org === PRIVATE ? "tidy" : "ask";
}

/**
 * What the captain does now. Autonomous mode is the master switch: "Runs it" acts as "Keeps things
 * tidy" unless the mode is on. "Only when I ask" never acts, whatever the switch says.
 */
export function effectiveLevel(level: CaptainLevel, mode: AutonomyMode): CaptainLevel {
  return level === "runs" && mode !== "on" ? "tidy" : level;
}

/** The upkeep chores a level runs. "Only when I ask" runs none. */
export function choresOf(level: CaptainLevel): readonly CaptainChore[] {
  return level === "ask" ? [] : CaptainChoreSchema.options;
}

/** The workspaces the captain knows: Private, then each org of majhi.yaml. */
export function workspaceIds(orgs: Readonly<Record<string, unknown>>): string[] {
  return [PRIVATE, ...Object.keys(orgs).filter((id) => id !== PRIVATE)];
}

/**
 * The move from the pick rule "workspaces it may work in" (before Phase 13) to the per-workspace
 * choice: each listed workspace becomes "Runs it" unless it already has a choice, and the list goes.
 * Undefined when there is nothing to move. The other workspaces keep their default.
 */
export function migratePickOrgs(
  autonomy: Pick<AutonomySettings, "orgs" | "pick">,
): { orgs: Record<string, AutonomyOrg>; pick: Omit<AutonomySettings["pick"], "orgs"> } | undefined {
  const listed = autonomy.pick.orgs;
  if (listed === undefined) return undefined;
  const orgs: Record<string, AutonomyOrg> = { ...autonomy.orgs };
  for (const id of new Set(listed)) {
    const had = orgs[id] ?? { push: false, merge: false };
    if (had.level === undefined) orgs[id] = { ...had, level: "runs" };
  }
  return { orgs, pick: { size: autonomy.pick.size } };
}
