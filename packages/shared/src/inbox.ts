import { z } from "zod";
import { TaskIdSchema } from "./tasks.ts";

/**
 * The Decisions inbox (SPEC 5.18): everything that waits for the owner as one kind of item. A decision
 * is derived from what already exists (room cards, the captain's cap and budget questions, signed-out
 * accounts) and stores nothing of its own, except the captain's recommendation.
 */

export const OwnerDecisionKindSchema = z.enum([
  "question",
  "approval",
  "ship",
  "budget",
  "cap",
  "paused",
  "sign-in",
  "secret",
]);
export type OwnerDecisionKind = z.infer<typeof OwnerDecisionKindSchema>;

/** One button. `id` is what `decisions.answer` takes as `option`. */
export const DecisionOptionSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  primary: z.literal(true).optional(),
});
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

/** Who suggests an option: the captain (`decisions.recommend`) or the agent that asked (an ask card's default). */
export const DecisionSuggestionSchema = z.object({
  option: z.string().min(1).max(200),
  reason: z.string().max(300),
  by: z.enum(["captain", "agent"]),
});
export type DecisionSuggestion = z.infer<typeof DecisionSuggestionSchema>;

/** Where "Open" goes. */
export const DecisionLinkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), id: TaskIdSchema, item: z.string().optional() }),
  z.object({ kind: z.literal("chat"), id: TaskIdSchema }),
  z.object({ kind: z.literal("captain") }),
  z.object({ kind: z.literal("limits") }),
  z.object({ kind: z.literal("account"), id: z.string().min(1) }),
]);
export type DecisionLink = z.infer<typeof DecisionLinkSchema>;

export const OwnerDecisionSchema = z.object({
  /** Stable while the decision waits: `room:<task>:<item>`, `cap:<org>:<chore>:<day>`, `budget:<scope>:<day>`, `signin:<account>`. */
  id: z.string().min(1).max(300),
  kind: OwnerDecisionKindSchema,
  /** The workspace (org id). Absent for what belongs to none, like a sign-in or the autonomous budget. */
  org: z.string().optional(),
  task: TaskIdSchema.optional(),
  /** The task's title, and whether it is a chat (named by its title). */
  taskTitle: z.string().optional(),
  chat: z.literal(true).optional(),
  /** One plain line. */
  title: z.string().min(1).max(300),
  /** The answers a click gives, primary first. Empty when the answer needs the task open. */
  options: z.array(DecisionOptionSchema),
  suggestion: DecisionSuggestionSchema.optional(),
  /** When it arrived (ISO). */
  at: z.string(),
  link: DecisionLinkSchema,
});
export type OwnerDecision = z.infer<typeof OwnerDecisionSchema>;

export const DecisionListSchema = z.object({ decisions: z.array(OwnerDecisionSchema) });
export type DecisionList = z.infer<typeof DecisionListSchema>;

/** `decisions.answer`: `option` is one of the decision's option ids. `text` replaces it on an ask card's free-text answer. */
export const DecisionAnswerInputSchema = z.object({
  id: z.string().min(1).max(300),
  option: z.string().min(1).max(200),
  text: z.string().min(1).max(2000).optional(),
});
export type DecisionAnswerInput = z.infer<typeof DecisionAnswerInputSchema>;

/** `decisions.recommend`, the captain's tool: its opinion on a decision, in one line. */
export const DecisionRecommendInputSchema = z.object({
  id: z.string().min(1).max(300),
  option: z.string().min(1).max(200),
  reason: z.string().trim().min(1).max(200),
});
export type DecisionRecommendInput = z.infer<typeof DecisionRecommendInputSchema>;

export const DECISION_KIND_LABEL: Record<OwnerDecisionKind, string> = {
  question: "Question",
  approval: "Approval",
  ship: "Ready to ship",
  budget: "Budget",
  cap: "Daily limit",
  paused: "Paused",
  "sign-in": "Sign-in",
  secret: "Secret",
};

export function roomDecisionId(task: string, item: string): string {
  return `room:${task}:${item}`;
}
export function capDecisionId(org: string, chore: string, day: string): string {
  return `cap:${org}:${chore}:${day}`;
}
export function budgetDecisionId(scope: string, day: string): string {
  return `budget:${scope}:${day}`;
}
export function signInDecisionId(account: string): string {
  return `signin:${account}`;
}

export type ParsedDecisionId =
  | { kind: "room"; task: string; item: string }
  | { kind: "cap"; org: string; chore: string; day: string }
  | { kind: "budget"; scope: string; day: string }
  | { kind: "signin"; account: string };

/** The parts of a decision id, or undefined when it is none of ours. Ids are short and hold no secrets. */
export function parseDecisionId(id: string): ParsedDecisionId | undefined {
  const [head, ...rest] = id.split(":");
  if (head === "room" && rest.length >= 2 && rest[0] !== "" && rest[1] !== "") {
    return { kind: "room", task: rest[0] as string, item: rest.slice(1).join(":") };
  }
  if (head === "cap" && rest.length === 3 && rest.every((p) => p !== "")) {
    return { kind: "cap", org: rest[0] as string, chore: rest[1] as string, day: rest[2] as string };
  }
  if (head === "budget" && rest.length === 2 && rest.every((p) => p !== "")) {
    return { kind: "budget", scope: rest[0] as string, day: rest[1] as string };
  }
  if (head === "signin" && rest.length >= 1 && rest[0] !== "") {
    return { kind: "signin", account: rest.join(":") };
  }
  return undefined;
}

/** "4 decisions need you", the one line a burst of alerts becomes. */
export function decisionsNeedText(count: number): string {
  return count === 1 ? "1 decision needs you" : `${count} decisions need you`;
}
