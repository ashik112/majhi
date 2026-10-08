import {
  type DecideRequestInput,
  type DecisionResult,
  findingTaskType,
  type StoredOrigin,
  TASK_TYPE_OF_BRANCH,
  TASK_TYPES,
  type TaskKind,
  type TaskType,
  TaskTypeSchema,
  type TaskTyping,
} from "@majhi/shared";
import { branchTypeSignal } from "./branch-naming.ts";

/** What the rules make of a new task: a type, and whether the text or source actually said it. */
export interface TypeGuess {
  type: TaskType;
  /** False when nothing in the text or source named a type: the type is only the default for the kind. */
  sure: boolean;
}

/**
 * The first guess at a task's type, from what exists already: the source of the finding it was made
 * from, then the words of the title (the branch-type reading), then the kind. No other text is read.
 */
export function guessType(task: {
  title: string;
  kind: TaskKind;
  origin?: StoredOrigin | undefined;
}): TypeGuess {
  if (task.origin?.kind === "finding") {
    const fromFinding = findingTaskType(task.origin.source, task.origin.severity);
    if (fromFinding !== undefined) return { type: fromFinding, sure: true };
  }
  const signal = branchTypeSignal(task.title);
  if (signal !== undefined) return { type: TASK_TYPE_OF_BRANCH[signal], sure: true };
  return { type: task.kind === "ops" ? "research" : "feature", sure: false };
}

const TYPE_MEANING: Record<TaskType, string> = {
  bug: "something that worked is broken or wrong, with no outage happening now",
  incident: "an outage or errors in production that customers feel right now, even when the text only says it is down",
  feature: "new behavior or a new capability",
  request: "someone asks for a change, an answer or a piece of work",
  research: "find out, compare or investigate, with nothing to ship",
  design: "design, copy or visual work",
  test: "add or fix tests",
  chore: "upkeep with no change in behavior: dependencies, config, cleanup",
};

/** The question for the decision provider, asked only when the rules were unsure. */
export function typeQuestion(task: {
  title: string;
  text: string;
  kind: TaskKind;
  origin?: StoredOrigin | undefined;
}): DecideRequestInput {
  return {
    state: {
      task: task.text,
      kind: task.kind,
      source: task.origin?.kind === "finding" ? task.origin.source : (task.origin?.kind ?? "none"),
    },
    questions: {
      type: {
        type: "choice",
        instructions: "What kind of work is this task?",
        options: TASK_TYPES.map((key) => ({ key, description: TYPE_MEANING[key] })),
        orders: "shifted",
      },
    },
  };
}

/**
 * The type the provider chose when it was sure enough, else the rules' guess. Either way it is intake's.
 * `fellBack` says the provider's answer did not count.
 */
export function chooseType(
  guess: TypeGuess,
  result: DecisionResult | undefined,
): { typing: TaskTyping; fellBack: boolean } {
  const answer = result?.answers.type;
  const picked = TaskTypeSchema.safeParse(answer?.value);
  if (answer?.gate?.accepted === true && picked.success)
    return { typing: { type: picked.data, by: "intake" }, fellBack: false };
  return { typing: { type: guess.type, by: "intake" }, fellBack: true };
}

/**
 * Who a `tasks.setType` caller counts as: the owner for any task, the captain for a task of the
 * workspace whose lane it speaks in, and nobody else. A captain outside a lane has no workspace, so it
 * may not type.
 */
export function typist(
  caller: { kind: "owner" } | { kind: "agent"; id: string },
  where: { boss: string | undefined; lane: string | undefined; taskOrg: string },
): { by: "owner" | "captain" } | { refusal: string } {
  if (caller.kind === "owner") return { by: "owner" };
  if (caller.id !== where.boss) return { refusal: "Only the owner or the captain sets a task's type." };
  if (where.lane === undefined)
    return { refusal: "The captain sets the type of a task from its workspace's chat." };
  if (where.lane !== where.taskOrg) return { refusal: "That task belongs to another workspace." };
  return { by: "captain" };
}
