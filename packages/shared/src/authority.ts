import { z } from "zod";
import {
  type AuthorityLevel,
  AuthorityLevelSchema,
  DEFAULT_LEVEL,
  type IncidentShips,
  levelAllows,
} from "./risk-kinds.ts";
import type { AutonomyOrg } from "./settings.ts";

/**
 * Who decides, per workspace (SPEC 5.18): nine rows, each `decide` (the captain does it while
 * Autonomous is On) or `ask` (it waits for the owner). The rows are not stored: they are derived from the
 * workspace's one authority level (`authorityFromLevel`), which is the only thing the owner sets.
 */
export const AuthorityChoiceSchema = z.enum(["decide", "ask"]);
export type AuthorityChoice = z.infer<typeof AuthorityChoiceSchema>;

export const AUTHORITY_ROWS = [
  "start",
  "questions",
  "approvals",
  "upkeep",
  "merge",
  "push",
  "deployStaging",
  "deployProduction",
  "tell",
] as const;
export const AuthorityRowSchema = z.enum(AUTHORITY_ROWS);
export type AuthorityRow = z.infer<typeof AuthorityRowSchema>;

export const AuthoritySchema = z.strictObject({
  /** Pick and start work from the backlog. */
  start: AuthorityChoiceSchema,
  /** Answer agents' questions. */
  questions: AuthorityChoiceSchema,
  /** Answer routine approval cards. */
  approvals: AuthorityChoiceSchema,
  /** Memory, projects, triage, cleanup, follow-ups. */
  upkeep: AuthorityChoiceSchema,
  /** Merge into the base branch, or merge the open merge request on the host (shipping). */
  merge: AuthorityChoiceSchema,
  /** Push and open merge requests. */
  push: AuthorityChoiceSchema,
  /** Deploy to staging after a merge. Absent in settings saved before this row: You. */
  deployStaging: AuthorityChoiceSchema.default("ask"),
  /** Deploy to production. Absent in settings saved before this row: You. */
  deployProduction: AuthorityChoiceSchema.default("ask"),
  /** Send the reply to the client. Absent in settings saved before this row: You. */
  tell: AuthorityChoiceSchema.default("ask"),
});
export type Authority = z.infer<typeof AuthoritySchema>;

/** The row names in plain words, for the table. */
export const AUTHORITY_LABEL: Record<AuthorityRow, string> = {
  start: "Start work from the backlog",
  questions: "Answer agents' questions",
  approvals: "Answer routine approval cards",
  upkeep: "Upkeep: memory, projects, triage, cleanup",
  merge: "Merge into the base branch, or the merge request on its host",
  push: "Push and open merge requests",
  deployStaging: "Deploy to staging",
  deployProduction: "Deploy to production",
  tell: "Client replies",
};

/** Each row as a short verb phrase, for one-line titles ("captain decides merge, push"). */
export const AUTHORITY_SHORT: Record<AuthorityRow, string> = {
  start: "start work",
  questions: "answer questions",
  approvals: "answer approvals",
  upkeep: "upkeep",
  merge: "merge",
  push: "push",
  deployStaging: "deploy staging",
  deployProduction: "deploy production",
  tell: "client replies",
};

/** What finishes "Refused: in Acme you decide ...". */
export const AUTHORITY_REFUSAL: Record<AuthorityRow, string> = {
  start: "when work starts, so the captain does not start it",
  questions: "how agents' questions are answered, so the captain does not answer them",
  approvals: "routine approval cards, so the captain does not answer them",
  upkeep: "the upkeep, so the captain does not do it",
  merge: "when work is merged, so the captain does not merge it",
  push: "when work is pushed, so the captain does not push it",
  deployStaging: "when work is deployed to staging, so the captain does not deploy it",
  deployProduction: "when work is deployed to production, so the captain does not deploy it",
  tell: "what clients are told, so the captain does not send client replies",
};

export const ALL_ASK: Authority = {
  start: "ask",
  questions: "ask",
  approvals: "ask",
  upkeep: "ask",
  merge: "ask",
  push: "ask",
  deployStaging: "ask",
  deployProduction: "ask",
  tell: "ask",
};

/**
 * The nine rows for a workspace's level and its incident switches. Pure and total: nothing else decides
 * what the captain may do by itself. Start, questions and approvals follow "the owner delegated anything";
 * upkeep (memory, triage, cleanup) stays on; the four shipping rows are the risk table's answer. Production
 * deploys are never a workspace-wide row: "Captain ships" covers an incident's fix only (`levelAllows`
 * with `incidentFix`), which the ship plan reads for that task.
 */
export function authorityFromLevel(level: AuthorityLevel, incident?: IncidentShips): Authority {
  const decide = (yes: boolean): AuthorityChoice => (yes ? "decide" : "ask");
  const works = level !== "ask";
  return {
    start: decide(works),
    questions: decide(works),
    approvals: decide(works),
    upkeep: "decide",
    merge: decide(levelAllows(level, "merge-main")),
    push: decide(levelAllows(level, "push-branch")),
    deployStaging: decide(levelAllows(level, "deploy-staging")),
    deployProduction: "ask",
    tell: decide(levelAllows(level, "client-message", { incident })),
  };
}

// ---------------------------------------------------------------------------
// Before the level: the saved table, the flags and the old three levels

/**
 * The authority table as it was saved before the one level: ten rows, with Deploy, Tell and Own added
 * over time. Read only to carry a workspace over to its level (`legacyLevelOf`, and the startup migration
 * that rewrites the file). Nothing reads it to decide anything.
 */
export const LegacyAuthoritySchema = z.strictObject({
  start: AuthorityChoiceSchema,
  questions: AuthorityChoiceSchema,
  approvals: AuthorityChoiceSchema,
  upkeep: AuthorityChoiceSchema,
  merge: AuthorityChoiceSchema,
  push: AuthorityChoiceSchema,
  deployStaging: AuthorityChoiceSchema.default("ask"),
  deployProduction: AuthorityChoiceSchema.default("ask"),
  tell: AuthorityChoiceSchema.default("ask"),
  own: AuthorityChoiceSchema.default("ask"),
});
export type LegacyAuthority = z.infer<typeof LegacyAuthoritySchema>;

/** What a workspace entry may still hold from before the level. */
export interface LegacyFields {
  level?: string | undefined;
  authority?: LegacyAuthority | undefined;
  push?: boolean | undefined;
  merge?: boolean | undefined;
  fullAccess?: boolean | undefined;
  ships?: unknown;
}

export function hasLegacyFields(entry: LegacyFields | undefined): boolean {
  if (entry === undefined) return false;
  return (
    entry.authority !== undefined ||
    entry.push !== undefined ||
    entry.merge !== undefined ||
    entry.fullAccess !== undefined ||
    entry.ships !== undefined ||
    entry.level === "tidy" ||
    entry.level === "runs"
  );
}

const ALL_DECIDE_LEGACY: LegacyAuthority = {
  start: "decide",
  questions: "decide",
  approvals: "decide",
  upkeep: "decide",
  merge: "decide",
  push: "decide",
  deployStaging: "decide",
  deployProduction: "decide",
  tell: "decide",
  own: "decide",
};

const ALL_ASK_LEGACY: LegacyAuthority = {
  start: "ask",
  questions: "ask",
  approvals: "ask",
  upkeep: "ask",
  merge: "ask",
  push: "ask",
  deployStaging: "ask",
  deployProduction: "ask",
  tell: "ask",
  own: "ask",
};

/** The old rows of a workspace, as the code before the level read them. */
export function legacyRowsOf(entry: LegacyFields, isPrivate: boolean): LegacyAuthority {
  const fromFlags = (): LegacyAuthority => {
    const ask = ALL_ASK_LEGACY;
    const base: LegacyAuthority =
      entry.level === "ask"
        ? ask
        : entry.level === "tidy"
          ? { ...ask, questions: "decide", approvals: "decide", upkeep: "decide" }
          : entry.level === "runs"
            ? {
                ...ask,
                start: "decide",
                questions: "decide",
                approvals: "decide",
                upkeep: "decide",
                merge: entry.merge === true ? "decide" : "ask",
                push: entry.push === true ? "decide" : "ask",
              }
            : isPrivate
              ? { ...ask, questions: "decide", approvals: "decide", upkeep: "decide" }
              : { ...ask, upkeep: "decide" };
    return {
      ...base,
      ...(entry.level === undefined && entry.merge === true ? { merge: "decide" as const } : {}),
      ...(entry.level === undefined && entry.push === true ? { push: "decide" as const } : {}),
    };
  };
  const saved = entry.authority ?? fromFlags();
  if (entry.fullAccess !== true) return saved;
  // Full access gave every row but Merge and Push, which kept their own switch; deploys and replies stayed the owner's.
  return {
    ...ALL_DECIDE_LEGACY,
    merge: saved.merge === "ask" ? "ask" : "decide",
    push: saved.push === "ask" ? "ask" : "decide",
    deployStaging: saved.deployStaging,
    deployProduction: saved.deployProduction,
    tell: saved.tell,
  };
}

/**
 * The nearest level for a workspace saved before the level, and the incident switches its Deploy production
 * and Tell rows become. The level never grants a client workspace a push or a merge the owner did not:
 * merge decided is Full, else push decided is Routine, else Ask me. Private, the owner's own space, is at
 * least Routine when the captain worked there at all.
 */
export function legacyLevelOf(
  entry: LegacyFields | undefined,
  isPrivate: boolean,
): { level: AuthorityLevel; incident: IncidentShips } {
  const rows = legacyRowsOf(entry ?? {}, isPrivate);
  const works = rows.start === "decide" || rows.questions === "decide" || rows.approvals === "decide";
  const level: AuthorityLevel =
    rows.merge === "decide" ? "full" : rows.push === "decide" || (isPrivate && works) ? "routine" : "ask";
  return {
    level,
    incident: {
      ...(rows.deployProduction === "decide" ? { fix: "ships" as const } : {}),
      ...(rows.tell === "decide" ? { clientUpdate: "sends" as const } : {}),
    },
  };
}

/**
 * The one authority level of a workspace: the level the owner chose; else, for an entry that still holds the
 * old table or flags, its nearest level; else Routine.
 */
export function levelOfOrg(entry: LegacyFields | undefined, isPrivate: boolean): AuthorityLevel {
  const own = entry?.level;
  if (own === "ask" || own === "routine" || own === "full") return own;
  if (hasLegacyFields(entry)) return legacyLevelOf(entry, isPrivate).level;
  return DEFAULT_LEVEL;
}

/**
 * A workspace's entry carried over to the level: its nearest level and incident switches written out, and
 * the old table, ship rules, flags and full access gone. An entry with nothing from before gets `unset`,
 * Routine unless the caller knows better. Pure: the startup migration and `authority.set` both write what
 * this returns.
 */
export function carriedOver(
  entry: AutonomyOrg | undefined,
  isPrivate: boolean,
  unset: AuthorityLevel = DEFAULT_LEVEL,
): AutonomyOrg {
  const {
    authority: _authority,
    ships: _ships,
    push: _push,
    merge: _merge,
    fullAccess: _full,
    ...rest
  } = entry ?? {};
  const chosen = entry?.level;
  const settled = chosen === "ask" || chosen === "routine" || chosen === "full";
  const old = hasLegacyFields(entry) ? legacyLevelOf(entry, isPrivate) : undefined;
  const level: AuthorityLevel = settled ? chosen : (old?.level ?? unset);
  const incident = { ...(rest.incident ?? {}) };
  if (incident.fix === undefined && old?.incident.fix !== undefined) incident.fix = old.incident.fix;
  if (incident.clientUpdate === undefined && old?.incident.clientUpdate !== undefined) {
    incident.clientUpdate = old.incident.clientUpdate;
  }
  return {
    ...rest,
    level,
    ...(Object.keys(incident).length === 0 ? {} : { incident }),
  };
}

// ---------------------------------------------------------------------------
// The command that sets it

/** `authority.set`: the level and the two incident switches of one workspace. The owner's alone. */
export const AuthoritySetInputSchema = z
  .strictObject({
    org: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    level: AuthorityLevelSchema.optional(),
    /** Who merges and deploys an incident's fix after its checks pass. */
    fix: z.enum(["ask", "ships"]).optional(),
    /** Who sends the client update of an incident. */
    clientUpdate: z.enum(["ask", "sends"]).optional(),
  })
  .refine((v) => v.level !== undefined || v.fix !== undefined || v.clientUpdate !== undefined, {
    message: "Say what to set: level, fix or clientUpdate",
  });
export type AuthoritySetInput = z.infer<typeof AuthoritySetInputSchema>;

export const AuthoritySetResultSchema = z.object({
  org: z.string(),
  level: AuthorityLevelSchema,
  fix: z.enum(["ask", "ships"]),
  clientUpdate: z.enum(["ask", "sends"]),
});
export type AuthoritySetResult = z.infer<typeof AuthoritySetResultSchema>;
