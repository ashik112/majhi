import {
  AUTHORITY_REFUSAL,
  type Authority,
  type AuthorityLevel,
  type AuthorityRow,
  type AutonomyMode,
  type AutonomySettings,
  authorityFromLevel,
  type CaptainChore,
  CaptainChoreSchema,
  choreSwitchWhy,
  type IncidentShips,
  levelOfOrg,
  PRIVATE,
} from "@majhi/shared";

/**
 * Who decides what in a workspace (SPEC 5.18). Each workspace has one authority level, set by the owner; the
 * nine rows the captain's code reads are derived from it (`authorityFromLevel`), never stored. Pure.
 */

/** The workspace's one authority level, as saved. */
export function levelOf(settings: Pick<AutonomySettings, "orgs">, org: string): AuthorityLevel {
  return levelOfOrg(settings.orgs[org], org === PRIVATE);
}

/** The workspace's two incident switches, as saved. */
export function incidentShipsOf(settings: Pick<AutonomySettings, "orgs">, org: string): IncidentShips {
  const incident = settings.orgs[org]?.incident;
  return { fix: incident?.fix, clientUpdate: incident?.clientUpdate };
}

/** Who decides each row in a workspace: derived from its level and incident switches. */
export function authorityOf(settings: Pick<AutonomySettings, "orgs">, org: string): Authority {
  return authorityFromLevel(levelOf(settings, org), incidentShipsOf(settings, org));
}

/**
 * The chores that run in a workspace now (`may.ts` decides): none while Stop everything is on; reacting
 * chores (ship, cards, questions, memory, cleanup) whatever Autonomous says; the scheduled upkeep only while
 * Autonomous is on. Each also needs the row of its own table.
 */
export function choresNow(
  authority: Authority,
  world: { mode: AutonomyMode; stopped?: boolean | undefined },
): readonly CaptainChore[] {
  const switches = { autonomous: world.mode, stopped: world.stopped === true };
  return choresOf(authority).filter((chore) => choreSwitchWhy(switches, chore) === undefined);
}

/**
 * The chores the captain runs. Each follows the row that governs it: cards `approvals`, questions
 * `questions`, the rest `upkeep`. Shipping runs when the captain merges, pushes, answers or does upkeep.
 */
export function choresOf(authority: Authority): readonly CaptainChore[] {
  return CaptainChoreSchema.options.filter((chore) => {
    switch (chore) {
      case "cards":
        return authority.approvals === "decide";
      case "questions":
        return authority.questions === "decide";
      case "ship":
        return (
          authority.merge === "decide" ||
          authority.push === "decide" ||
          authority.upkeep === "decide" ||
          authority.questions === "decide"
        );
      default:
        return authority.upkeep === "decide";
    }
  });
}

/** The refusal line when a row is "Ask me": "Refused: in Acme you decide when work starts, ...". */
export function askedWhy(row: AuthorityRow, name: string): string {
  return `in ${name} you decide ${AUTHORITY_REFUSAL[row]}`;
}

/** The same line to start a sentence: "In Acme you decide when work starts, so ...". */
export function askedSentence(row: AuthorityRow, name: string): string {
  const line = askedWhy(row, name);
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
}

/** The workspaces the captain knows: Private, then each org of majhi.yaml. */
export function workspaceIds(orgs: Readonly<Record<string, unknown>>): string[] {
  return [PRIVATE, ...Object.keys(orgs).filter((id) => id !== PRIVATE)];
}
