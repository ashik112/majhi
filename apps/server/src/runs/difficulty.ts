import type { DecideRequestInput, EffortTier, ModelTier, Role, TaskKind, Tier } from "@majhi/shared";

/**
 * How much work a task is, as the decision provider rates it for an `auto` model and effort pick
 * (SPEC 5.12). Laya cannot tell models apart by name, but it can read a task: the level maps to a
 * model tier and an effort tier, in code, over whatever the CLI offers. No model names here.
 */
export const DIFFICULTY_LEVELS = ["trivial", "small", "medium", "large"] as const;
export type Difficulty = (typeof DIFFICULTY_LEVELS)[number];

/** Each level with what it means; Laya reads `key: description`. Worded after checks on the real model. */
export const DIFFICULTY_OPTIONS: readonly { key: Difficulty; description: string }[] = [
  { key: "trivial", description: "a one-line fix, a typo or a version bump" },
  { key: "small", description: "a small change in one or two files" },
  { key: "medium", description: "a feature or a fix across several files, with tests" },
  { key: "large", description: "a big design, a hard bug hunt, or work in many parts" },
];

export function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === "string" && (DIFFICULTY_LEVELS as readonly string[]).includes(value);
}

/** How a role reads in the state. */
export function rolePhrase(role: Role): string {
  switch (role) {
    case "Lead":
      return "Lead, who plans and reviews the work";
    case "Builder":
      return "Builder, who writes the code";
    case "Reviewer":
      return "Reviewer, who checks the work of others";
    case "Tester":
      return "Tester, who runs and checks the results";
    case "Root":
      return "Root agent, who organizes projects and tasks";
  }
}

export interface TaskBrief {
  title: string;
  /** What the owner typed. */
  brief: string;
  kind: TaskKind;
  /** Project ids. */
  repos: readonly string[];
  role: Role;
}

/**
 * The question: named fields about the task, never the agent's id or its generic instructions,
 * which say nothing about this task and would crowd the brief out of Laya's window.
 */
export function difficultyQuestion(task: TaskBrief): DecideRequestInput {
  const title = task.title.trim();
  const brief = task.brief.trim();
  // The title is the brief's first line: do not spend the window on it twice.
  const description = brief.startsWith(title) ? brief.slice(title.length).trim() : brief;
  return {
    state: {
      task: title || "untitled",
      ...(description === "" ? {} : { description }),
      kind: task.kind,
      repos: task.repos.length === 0 ? "none" : task.repos.join(", "),
      role: rolePhrase(task.role),
    },
    questions: {
      difficulty: {
        type: "choice",
        instructions: "How much work is the task for the agent in role?",
        options: DIFFICULTY_OPTIONS.map((o) => ({ ...o })),
        // Laya favours some positions: ask in every shift and average. `none` stays in.
        abstain: true,
        orders: "shifted",
      },
    },
  };
}

const MODEL_STEPS: readonly ModelTier[] = ["cheapest", "balanced", "most-capable"];
const EFFORT_STEPS: readonly EffortTier[] = ["lowest", "middle", "highest"];

/** How far each level moves the role's tiers: one step down for little work, one up for a lot. */
const SHIFT: Record<Difficulty, { model: number; effort: number }> = {
  trivial: { model: -1, effort: -1 },
  small: { model: 0, effort: -1 },
  medium: { model: 0, effort: 0 },
  large: { model: 1, effort: 1 },
};

function step<T>(steps: readonly T[], from: T, by: number): T {
  const i = Math.min(steps.length - 1, Math.max(0, steps.indexOf(from) + by));
  return steps[i] ?? from;
}

/**
 * The tiers for a task of this difficulty, from the role's own tiers (agent, then org, then Hub
 * setup): at most one step from them, so the owner's choice for a role still sets the range.
 */
export function tierForDifficulty(role: Tier, level: Difficulty): Tier {
  const shift = SHIFT[level];
  return {
    model: step(MODEL_STEPS, role.model, shift.model),
    effort: step(EFFORT_STEPS, role.effort, shift.effort),
  };
}
