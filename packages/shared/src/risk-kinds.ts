import { z } from "zod";

/**
 * Permissions by risk (docs/briefs/workflow-reset.md, step 1b). One typed answer to "may this happen
 * without asking the owner": every action an agent or the captain takes has a risk kind, and each
 * workspace has one authority level that says which kinds go ahead. Nothing here reads text; the callers
 * pass typed data (a command's name, an ACP tool kind, a parsed argv, an image reference).
 */

export const RISK_KINDS = [
  /** Inside the task: its worktree, containers and network. Reads, edits, commands, installs, tests, builds. */
  "sandbox",
  /** The task's own branch goes to its remote, or a draft pull request is opened for it. */
  "push-branch",
  "merge-main",
  "deploy-staging",
  "deploy-production",
  /** Something said to a client, or visible to people outside majhi. */
  "client-message",
  "client-server-write",
  "delete-outside",
  "secret",
  "over-budget",
  /** An image that is neither an official Docker image nor already allowed in the workspace. */
  "new-image",
  /** Not classified here: the owner's approval modes decide (a card unless the mode says run). */
  "other",
] as const;
export const RiskKindSchema = z.enum(RISK_KINDS);
export type RiskKind = z.infer<typeof RiskKindSchema>;

export const AUTHORITY_LEVELS = ["ask", "routine", "full"] as const;
export const AuthorityLevelSchema = z.enum(AUTHORITY_LEVELS);
export type AuthorityLevel = z.infer<typeof AuthorityLevelSchema>;

/** What a workspace gets when the owner chose nothing. */
export const DEFAULT_LEVEL: AuthorityLevel = "routine";

/** The level in words, for the one control that sets it. */
export const LEVEL_LABEL: Record<AuthorityLevel, string> = {
  ask: "Ask me",
  routine: "Routine",
  full: "Full",
};

/** What each level lets through without a card. Everything not listed asks. */
export const LEVEL_ALLOWS: Record<AuthorityLevel, readonly RiskKind[]> = {
  ask: ["sandbox"],
  routine: ["sandbox", "push-branch"],
  full: ["sandbox", "push-branch", "merge-main", "deploy-staging"],
};

/** The two incident switches (step 4 builds the flow; the settings are stored now). */
export interface IncidentShips {
  /** Captain ships: merge and deploy an incident's fix after its checks pass. */
  fix?: "ask" | "ships" | undefined;
  /** Captain sends: the client update goes out without the owner. */
  clientUpdate?: "ask" | "sends" | undefined;
}

export interface RiskContext {
  incident?: IncidentShips | undefined;
  /** The action is part of an incident's fix, so the workspace's "Captain ships" switch applies to it. */
  incidentFix?: boolean | undefined;
}

/**
 * Whether the level lets this kind through. The answer for every kind and level is the table above,
 * plus the two incident switches the owner set for the workspace. `secret`, `client-server-write`,
 * `delete-outside`, `over-budget`, `new-image` and `other` are never granted by a level.
 */
export function levelAllows(level: AuthorityLevel, kind: RiskKind, ctx: RiskContext = {}): boolean {
  if (LEVEL_ALLOWS[level].includes(kind)) return true;
  if (kind === "client-message") return ctx.incident?.clientUpdate === "sends";
  if (ctx.incidentFix === true && ctx.incident?.fix === "ships") {
    return kind === "merge-main" || kind === "deploy-staging" || kind === "deploy-production";
  }
  return false;
}

// ---------------------------------------------------------------------------
// "Always": one rule per workspace and kind

/** The kinds an owner can say "Always" to. The others ask every time, or have their own switch. */
export const ALWAYS_KINDS = [
  "push-branch",
  "merge-main",
  "deploy-staging",
] as const satisfies readonly RiskKind[];
export type AlwaysKind = (typeof ALWAYS_KINDS)[number];

export function isAlwaysKind(kind: RiskKind): kind is AlwaysKind {
  return (ALWAYS_KINDS as readonly string[]).includes(kind);
}

const RULE_ORG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** "Always allow this kind of action in this workspace", saved from a card. It only turns a card into a go-ahead. */
export const AllowRuleSchema = z.strictObject({
  org: z.string().regex(RULE_ORG),
  kind: z.enum(ALWAYS_KINDS),
});
export type AllowRule = z.infer<typeof AllowRuleSchema>;

export function ruleCovers(rules: readonly AllowRule[], org: string, kind: RiskKind): boolean {
  return rules.some((rule) => rule.org === org && rule.kind === kind);
}

/** Adds the rule unless it is already there. Never two rules for one workspace and kind. */
export function withRule(rules: readonly AllowRule[], rule: AllowRule): AllowRule[] {
  return ruleCovers(rules, rule.org, rule.kind) ? [...rules] : [...rules, rule];
}

/** The verdict for one action: go ahead, or ask. `by` says what let it through. */
export type RiskVerdict = { go: true; by: "level" | "rule" | "image" } | { go: false };

export function riskVerdict(
  level: AuthorityLevel,
  rules: readonly AllowRule[],
  org: string,
  kind: RiskKind,
  ctx: RiskContext = {},
): RiskVerdict {
  if (levelAllows(level, kind, ctx)) return { go: true, by: "level" };
  if (isAlwaysKind(kind) && ruleCovers(rules, org, kind)) return { go: true, by: "rule" };
  return { go: false };
}

// ---------------------------------------------------------------------------
// Images

/**
 * Whether an image reference names a Docker Official Image: a bare name (`postgres:16-alpine`), or the
 * same under `library/`, with or without Docker Hub's own host. Anything with another namespace or
 * registry is not official. Read by splitting the reference, never by matching it as text.
 */
export function isOfficialImage(ref: string): boolean {
  const withoutDigest = ref.trim().split("@")[0] ?? "";
  const parts = withoutDigest.split("/");
  const last = parts.at(-1) ?? "";
  const name = last.split(":")[0] ?? "";
  if (name === "" || parts.some((p) => p === "")) return false;
  const head = parts.slice(0, -1);
  if (head.length === 0) return true;
  const hub = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);
  if (head.length === 1) return head[0] === "library";
  if (head.length === 2) return hub.has(head[0] ?? "") && head[1] === "library";
  return false;
}

// ---------------------------------------------------------------------------
// ACP tool kinds

/** The ACP tool kinds that never leave the task: they read, search, think or fetch inside its network. */
const READ_KINDS: ReadonlySet<string> = new Set(["read", "search", "think", "fetch"]);
const WRITE_KINDS: ReadonlySet<string> = new Set(["edit", "delete", "move"]);

/** What an ACP tool kind is. `execute` is read by its parsed command line, so it is `undefined` here. */
export function toolKindRisk(kind: string | undefined): "reads" | "writes" | "execute" | "unknown" {
  if (kind === undefined) return "unknown";
  if (READ_KINDS.has(kind)) return "reads";
  if (WRITE_KINDS.has(kind)) return "writes";
  if (kind === "execute") return "execute";
  return "unknown";
}

/** How much a kind weighs when a request holds several actions: the heaviest decides. */
const WEIGHT: Record<RiskKind, number> = {
  sandbox: 0,
  "push-branch": 1,
  "deploy-staging": 2,
  "merge-main": 3,
  "client-message": 4,
  "deploy-production": 5,
  "new-image": 6,
  "client-server-write": 7,
  "delete-outside": 8,
  "over-budget": 9,
  secret: 10,
  other: 11,
};

export function heaviest(kinds: readonly RiskKind[]): RiskKind {
  let top: RiskKind = "sandbox";
  for (const kind of kinds) if (WEIGHT[kind] > WEIGHT[top]) top = kind;
  return top;
}

/** The kind in words, for the card and the room line. */
export const RISK_LABEL: Record<RiskKind, string> = {
  sandbox: "work inside the task",
  "push-branch": "push the task's branch",
  "merge-main": "merge into the main branch",
  "deploy-staging": "deploy to staging",
  "deploy-production": "deploy to production",
  "client-message": "message a client",
  "client-server-write": "change something on a client's server",
  "delete-outside": "delete outside the task",
  secret: "use a secret or a key",
  "over-budget": "go over budget",
  "new-image": "use an image nobody allowed yet",
  other: "something majhi does not classify",
};
