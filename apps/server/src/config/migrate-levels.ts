import { isDeepStrictEqual } from "node:util";
import {
  type AllowRule,
  type AutonomyOrg,
  type AutonomySettings,
  carriedOver,
  commandRisk,
  DEFAULT_LEVEL,
  hasLegacyFields,
  isAlwaysKind,
  levelAllows,
  type PolicySettings,
  PRIVATE,
  type RiskKind,
  type SavedRule,
} from "@majhi/shared";
import { z } from "zod";
import { levelOf } from "../captain/levels.ts";
import { shellRisk } from "../runs/shell-risk.ts";

/**
 * The move to permissions by risk (docs/briefs/workflow-reset.md, step 1b), once, on startup:
 *
 * 1. Each workspace's old table, ship rules, push and merge flags, full access and old level become its one
 *    authority level (`carriedOver`), written out. A workspace nobody configured is Routine in Private and
 *    Ask me elsewhere, what it effectively was.
 * 2. Each saved "always allow" (one agent, one command or tool, one task or workspace) becomes at most one rule
 *    per workspace and kind of action, or goes: a rule for something inside the task, a rule the workspace's
 *    level already allows, a rule for a kind that always asks, and a rule for a task that is gone are dropped,
 *    and per-task duplicates collapse into one.
 *
 * Pure: the file write and the lookup of a task's workspace are the caller's.
 */

/** What a majhi.yaml from before the level held in `autonomy.pick`: the workspaces the captain could work in. */
const LegacyPickSchema = z.object({ orgs: z.array(z.string()).optional() }).catch({});

export interface LevelMigrationInput {
  autonomy: Pick<AutonomySettings, "orgs" | "pick">;
  policy: Pick<PolicySettings, "rules">;
  /** The workspaces of majhi.yaml, besides Private. */
  orgs: readonly string[];
  /** The workspace of a task, or undefined when the task is gone. */
  orgOfTask: (task: string) => string | undefined;
}

export interface LevelMigration {
  orgs: Record<string, AutonomyOrg>;
  rules: AllowRule[];
  /** Whether the saved rules changed: the file's `policy` is left alone when they did not. */
  rulesChanged: boolean;
  summary: string;
}

/** The kind of action a saved rule's key stood for. The key is a command name or one of the three prefixed forms. */
function kindOfKey(command: string): RiskKind {
  if (command.startsWith("shell:")) {
    // Read as a line of a task with no folders known: a path outside is not provable, so only a kind it names survives.
    return shellRisk(command.slice("shell:".length), { roots: [], cwd: "/", branches: [] });
  }
  if (command.startsWith("tool:")) return "sandbox";
  if (command.startsWith("connection:")) return "client-server-write";
  return commandRisk(command);
}

function sameEntry(a: AutonomyOrg | undefined, b: AutonomyOrg): boolean {
  return a !== undefined && isDeepStrictEqual(a, b);
}

export function planLevels(input: LevelMigrationInput): LevelMigration | undefined {
  const { autonomy } = input;
  const listed = new Set(LegacyPickSchema.parse(autonomy.pick ?? {}).orgs ?? []);
  const saved = input.policy.rules as readonly SavedRule[];
  // Only a file that still holds something from before the level is migrated. In one, a workspace with no
  // saved entry was effectively Ask me, so it stays that way; elsewhere an unset workspace is the default.
  const oldFile =
    listed.size > 0 ||
    saved.some((r) => !("kind" in r)) ||
    Object.values(autonomy.orgs).some((entry) => hasLegacyFields(entry));
  if (!oldFile) return undefined;
  const ids = new Set([...input.orgs, ...Object.keys(autonomy.orgs)]);
  const orgs: Record<string, AutonomyOrg> = { ...autonomy.orgs };
  const moved: string[] = [];
  for (const id of ids) {
    let entry = autonomy.orgs[id];
    // The pick rule "workspaces it may work in" was the old "Runs it" for each listed workspace.
    if (listed.has(id) && entry?.level === undefined && entry?.authority === undefined) {
      entry = { ...entry, level: "runs" };
    }
    // Private with nothing saved is Routine by default, which is what it was: nothing to write.
    if (entry === undefined && id === PRIVATE) continue;
    const next = carriedOver(entry, id === PRIVATE, id === PRIVATE ? DEFAULT_LEVEL : "ask");
    if (sameEntry(autonomy.orgs[id], next)) continue;
    orgs[id] = next;
    moved.push(id);
  }

  const settled = { orgs };
  const kept: AllowRule[] = [];
  for (const rule of saved) {
    const own = "kind" in rule;
    const org = own
      ? rule.org
      : (rule.org ?? (rule.task === undefined ? undefined : input.orgOfTask(rule.task)));
    const kind = own ? rule.kind : kindOfKey(rule.command);
    const useful =
      org !== undefined &&
      isAlwaysKind(kind) &&
      !levelAllows(levelOf(settled, org), kind) &&
      !kept.some((k) => k.org === org && k.kind === kind);
    if (useful) kept.push({ org, kind });
  }
  const dropped = saved.length - kept.length;
  const sameRules = !saved.some((r) => !("kind" in r)) && dropped === 0;
  if (moved.length === 0 && sameRules) return undefined;
  const parts = [
    ...(moved.length === 0
      ? []
      : [`moved ${moved.length} workspace${moved.length === 1 ? "" : "s"} to one authority level each`]),
    ...(sameRules
      ? []
      : [`${kept.length} Always rule${kept.length === 1 ? "" : "s"} kept, ${dropped} dropped`]),
  ];
  return {
    orgs,
    rules: kept,
    rulesChanged: !sameRules,
    summary: parts.join("; "),
  };
}
