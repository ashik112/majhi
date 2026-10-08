import { z } from "zod";
import { type Authority, AuthorityChoiceSchema } from "./authority.ts";
import { IdSchema } from "./ids.ts";
import { TASK_TYPE_LABEL, type TaskType, TaskTypeSchema } from "./task-type.ts";

/**
 * Ship rules (docs/design/ship-without-me.md, section 2). One source of truth: the authority rows give
 * the answer for a workspace, and an ordered list of rules refines the four ship steps by what the task
 * is. The first rule whose `when` matches decides; with no match, the rows decide.
 *
 * A rule can only choose who does a step. It cannot lift a guard: green checks for the exact head, the
 * secret scan, protected repos, the branch allowlist, hours, freezes, presence, one ship per state of the work and the re-check are
 * checked by the code that does the step, after this answer says the captain may.
 */

/** The steps a rule can change. Push stays on its row: a branch leaves the machine the same way for every task. */
export const SHIP_STEPS = ["merge", "deployStaging", "deployProduction", "tell"] as const;
export type ShipStep = (typeof SHIP_STEPS)[number];

/** Who does one step: the captain, or the owner (a step the owner leaves to themselves waits for them). */
export type Who = "captain" | "owner";

/** What the task is, as far as a rule can tell. Everything here is derived on read, never stored on the rule. */
export interface ShipFacts {
  /** Absent: the task is untyped, so no rule that names a type applies. */
  type?: TaskType | undefined;
  /** The wiki components the task's changed files fall in. Absent: not known (no wiki, or the diff could not be read). */
  areas?: readonly string[] | undefined;
  /** Changed files that fall in no component. A rule that names areas applies only when this is 0. */
  unmapped?: number | undefined;
  /** Added plus removed lines against the merge base. Absent: not known (a binary file, or the diff could not be read). */
  changedLines?: number | undefined;
  /** The projects the task changes. */
  projects: readonly string[];
}

export const ShipWhenSchema = z.strictObject({
  /** The task types the rule covers. Empty: any task, typed or not. */
  types: z.array(TaskTypeSchema).max(8),
  /** Wiki component names. The rule applies when every area the task touches is one of them. */
  areas: z.array(z.string().trim().min(1).max(80)).min(1).max(20).optional(),
  /** The rule applies up to this many changed lines. */
  maxChangedLines: z.number().int().min(1).max(1_000_000).optional(),
  /** Project ids. The rule applies when every project the task changes is one of them. */
  projects: z.array(IdSchema).min(1).max(50).optional(),
});
export type ShipWhen = z.infer<typeof ShipWhenSchema>;

export const ShipRuleSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]{8}$/),
  when: ShipWhenSchema,
  merge: AuthorityChoiceSchema,
  deployStaging: AuthorityChoiceSchema,
  deployProduction: AuthorityChoiceSchema,
  tell: AuthorityChoiceSchema,
});
export type ShipRule = z.infer<typeof ShipRuleSchema>;

export const MAX_SHIP_RULES = 50;

/** Whether a rule's condition holds for a task. A condition the task cannot show never holds. */
export function shipRuleMatches(when: ShipWhen, facts: ShipFacts): boolean {
  if (when.types.length > 0 && (facts.type === undefined || !when.types.includes(facts.type))) return false;
  if (when.maxChangedLines !== undefined) {
    if (facts.changedLines === undefined || facts.changedLines > when.maxChangedLines) return false;
  }
  if (when.areas !== undefined) {
    const listed = when.areas;
    const touched = facts.areas;
    if (touched === undefined || touched.length === 0 || (facts.unmapped ?? 0) > 0) return false;
    if (!touched.every((a) => listed.includes(a))) return false;
  }
  if (when.projects !== undefined) {
    const listed = when.projects;
    if (facts.projects.length === 0 || !facts.projects.every((p) => listed.includes(p))) return false;
  }
  return true;
}

/** The first rule that matches, or undefined: then the rows decide. */
export function matchingShipRule(rules: readonly ShipRule[], facts: ShipFacts): ShipRule | undefined {
  return rules.find((rule) => shipRuleMatches(rule.when, facts));
}

/** Who does each step of shipping one task, and the rule that said so. */
export interface ShipSteps {
  merge: Who;
  push: Who;
  deployStaging: Who;
  deployProduction: Who;
  tell: Who;
  /** The id of the rule that decided, or undefined when the rows did. */
  rule: string | undefined;
}

const who = (choice: "decide" | "ask"): Who => (choice === "decide" ? "captain" : "owner");

/**
 * Who does each step, for a task. `authority` is the workspace's rows as saved. `captainActs` is the
 * answer of `mayWork` for this task's job: when the captain may not act at all (Stop everything, or a
 * backlog task while Auto-pilot is off) every step is the owner's, whatever a row or a rule says.
 * Otherwise each step reads only its own line.
 */
export function shipSteps(
  authority: Authority,
  rules: readonly ShipRule[],
  facts: ShipFacts,
  captainActs: boolean,
): ShipSteps {
  if (!captainActs) {
    return {
      merge: "owner",
      push: "owner",
      deployStaging: "owner",
      deployProduction: "owner",
      tell: "owner",
      rule: undefined,
    };
  }
  const rule = matchingShipRule(rules, facts);
  const pick = (step: ShipStep): Who => who(rule === undefined ? authority[step] : rule[step]);
  return {
    merge: pick("merge"),
    push: who(authority.push),
    deployStaging: pick("deployStaging"),
    deployProduction: pick("deployProduction"),
    tell: pick("tell"),
    rule: rule?.id,
  };
}

/** The guards no rule can switch off, as the sheet lists them. The code that does each step enforces them. */
export const SHIP_GUARDS: readonly string[] = [
  "Green checks on the exact head",
  "Secret scan",
  "Protected repos and paths",
  "Hours and freezes",
  "Not while you type",
  "Once per state of the work",
  "Re-check before a push",
];

/** The step a hold of the owner names on the trail and the board: "Merge", "Deploy production". */
export const SHIP_STEP_LABEL: Record<ShipStep | "push", string> = {
  merge: "Merge",
  push: "Push",
  deployStaging: "Deploy staging",
  deployProduction: "Deploy production",
  tell: "Tell the client",
};

function listOr(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

/** What a rule covers, in words: "A bug or incident up to 200 lines in web". */
export function shipRuleSubject(when: ShipWhen): string {
  const types = when.types.map((t) => TASK_TYPE_LABEL[t].toLowerCase());
  const noun = types.length === 0 ? "task" : listOr(types);
  const article = types.length === 0 ? "Any" : /^[aeiou]/.test(noun) ? "An" : "A";
  const parts = [`${article} ${noun}`];
  if (when.maxChangedLines !== undefined) parts.push(`up to ${when.maxChangedLines} lines`);
  if (when.areas !== undefined) parts.push(`in ${listOr(when.areas)}`);
  if (when.projects !== undefined) parts.push(`of ${listOr(when.projects)}`);
  return parts.join(" ");
}

/** One plain sentence for a rule: what the captain does by itself and what waits for the owner. */
export function shipRuleSentence(rule: ShipRule): string {
  const subject = shipRuleSubject(rule.when);
  const merge = rule.merge === "decide";
  const staging = rule.deployStaging === "decide";
  const what = merge
    ? staging
      ? "merges and deploys to staging by itself"
      : "merges by itself; staging asks you"
    : staging
      ? "asks you to merge, then deploys to staging by itself"
      : "asks you to merge and to deploy to staging";
  const production =
    rule.deployProduction === "decide" ? "production deploys by itself" : "production asks you";
  const tell =
    rule.tell === "decide"
      ? "The reply to the client goes out by itself."
      : "The reply to the client waits for you.";
  return `${subject} ${what}; ${production}. ${tell}`;
}
