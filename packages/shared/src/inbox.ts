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
  /** The answer needs typed text (Ask for changes, a free-text answer): the screen opens a reply box and sends it as `text`. */
  text: z.literal(true).optional(),
  /**
   * What a batch does with this option: `approve` is what "Approve" takes (allow once, merge, resume,
   * raise), `leave` is what "Leave" takes (reject, keep the budget). Absent: a batch never picks it.
   */
  effect: z.enum(["approve", "leave"]).optional(),
});
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

/** Who suggests an option: the captain (`decisions.recommend`) or the agent that asked (an ask card's default). */
export const DecisionSuggestionSchema = z.object({
  option: z.string().min(1).max(200),
  reason: z.string().max(600),
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
  /** What it is in a sentence the owner can act on ("@acme-builder finished 'Fix the invoice total' and it is ready to ship"). */
  sentence: z.string().max(500).optional(),
  /** The answers a click gives, primary first. Empty when the answer needs the task open. */
  options: z.array(DecisionOptionSchema),
  suggestion: DecisionSuggestionSchema.optional(),
  /** When it arrived (ISO). */
  at: z.string(),
  link: DecisionLinkSchema,
});
export type OwnerDecision = z.infer<typeof OwnerDecisionSchema>;

/** One changed file of a ready-to-ship task. */
export const DecisionFileSchema = z.object({
  path: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type DecisionFile = z.infer<typeof DecisionFileSchema>;

/**
 * What the owner needs to decide without opening the task (`decisions.detail`): read when a decision
 * is selected, not with the list, because the diff and the room are not free to read.
 */
export const DecisionDetailSchema = z.object({
  id: z.string(),
  /** The agent's last message in the task: its hand-back, or the context of its question. */
  handback: z.object({ agent: z.string(), text: z.string(), at: z.string() }).optional(),
  /** The change a ready-to-ship task makes, over all its repos. */
  diff: z
    .object({
      files: z.number().int().nonnegative(),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
      /** The biggest changes first, at most six. */
      top: z.array(DecisionFileSchema),
      uncommitted: z.boolean(),
      error: z.string().optional(),
    })
    .optional(),
  /** Where it goes: each repo's task branch and the branch it merges into. */
  repos: z.array(z.object({ project: z.string(), branch: z.string(), into: z.string() })).optional(),
  /** What the captain checked before it asked, in a sentence. */
  checks: z.string().optional(),
  /** The full questions of a card, with their choices. */
  questions: z
    .array(z.object({ question: z.string(), options: z.array(z.string()), freeText: z.boolean() }))
    .optional(),
  /** Options that cannot be taken now, with the reason (Merge when nothing is committed). */
  blocked: z.record(z.string(), z.string()).optional(),
});
export type DecisionDetail = z.infer<typeof DecisionDetailSchema>;

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

/**
 * One word per kind, in the queue, the filter chips, the detail head and the bell. Three server kinds share
 * a word because the owner meets them the same way: a secret and a sign-in are both access.
 */
export const DECISION_KIND_LABEL: Record<OwnerDecisionKind, string> = {
  question: "Question",
  approval: "Access",
  ship: "Ship",
  budget: "Money",
  cap: "Money",
  paused: "Paused",
  "sign-in": "Access",
  secret: "Access",
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

// ---------------------------------------------------------------------------
// Batches (SPEC 5.18, Batch approve)

export const BatchIntentSchema = z.enum(["approve", "leave"]);
export type BatchIntent = z.infer<typeof BatchIntentSchema>;

/** The most decisions one batch takes. */
export const BATCH_MAX = 1000;

/** `decisions.answerBatch`: `batch` is the client's key for this click, so a second send of it changes nothing. */
export const DecisionBatchInputSchema = z.object({
  batch: z.string().trim().min(8).max(80),
  intent: BatchIntentSchema,
  ids: z.array(z.string().min(1).max(300)).min(1).max(BATCH_MAX),
});
export type DecisionBatchInput = z.infer<typeof DecisionBatchInputSchema>;

export const DecisionBatchResultSchema = z.object({
  batch: z.string(),
  intent: BatchIntentSchema,
  /** Answered. */
  done: z.array(z.string()),
  /** Not taken, with the reason: no button of that kind, gone already, the captain recommends otherwise. */
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
  /** Tried and refused or broken, with the error. The rest of the batch went on. */
  failed: z.array(z.object({ id: z.string(), error: z.string() })),
  /** What still waits. */
  decisions: z.array(OwnerDecisionSchema),
});
export type DecisionBatchResult = z.infer<typeof DecisionBatchResultSchema>;

type Batchable = Pick<OwnerDecision, "id" | "kind" | "options" | "suggestion">;

/**
 * The option a batch takes for a decision, or why it takes none. "Approve" never overrides a
 * recommendation to do something else: a request the captain recommends rejecting is not approved in bulk.
 */
export function batchPick(
  decision: Pick<OwnerDecision, "options" | "suggestion">,
  intent: BatchIntent,
): { option: DecisionOption } | { reason: string } {
  const option = decision.options.find((o) => o.effect === intent && o.text !== true);
  if (option === undefined) {
    return {
      reason: intent === "approve" ? "It has no button to approve in bulk" : "It has no button to leave in bulk",
    };
  }
  const suggested = decision.suggestion;
  if (intent === "approve" && suggested !== undefined && suggested.option !== option.id) {
    const other = decision.options.find((o) => o.id === suggested.option);
    return {
      reason: `${suggested.by === "captain" ? "The captain" : "The agent"} suggests ${other?.label ?? "something else"}`,
    };
  }
  return { option };
}

/** The action in two or three words: "allow once", "merge", "keep the budget". */
function batchLabel(kind: OwnerDecisionKind, option: DecisionOption): string {
  if (kind === "approval" && option.effect === "leave") return "reject";
  if ((kind === "budget" || kind === "cap") && option.effect === "leave") return "keep the budget";
  if ((kind === "budget" || kind === "cap") && option.effect === "approve") return "raise";
  return option.label.toLowerCase();
}

/** What a batch click will do, counted by action: ids it takes, how many wait, "allow once 9, merge 2". */
export function batchPlan(
  decisions: readonly Batchable[],
  intent: BatchIntent,
): { ids: string[]; skipped: number; counts: { label: string; count: number }[] } {
  const counts = new Map<string, number>();
  const ids: string[] = [];
  let skipped = 0;
  for (const d of decisions) {
    const pick = batchPick(d, intent);
    if ("reason" in pick) {
      skipped++;
      continue;
    }
    ids.push(d.id);
    const label = batchLabel(d.kind, pick.option);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return { ids, skipped, counts: [...counts].map(([label, count]) => ({ label, count })) };
}

/** One line of what Approve N or Leave N will do: "Allow once 9, merge 2. 1 will wait for you." */
export function batchSummary(decisions: readonly Batchable[], intent: BatchIntent): string {
  const plan = batchPlan(decisions, intent);
  if (plan.ids.length === 0) return "None of these can be done in bulk.";
  const parts = plan.counts.map((c) => `${c.label} ${c.count}`);
  const first = parts[0] ?? "";
  const line = [`${first.charAt(0).toUpperCase()}${first.slice(1)}`, ...parts.slice(1)].join(", ");
  return plan.skipped === 0 ? `${line}.` : `${line}. ${plan.skipped} will wait for you.`;
}

/** The decisions that are like this one: the same kind in the same task (or workspace, when it has no task). */
export function likeThis<T extends Pick<OwnerDecision, "kind" | "task" | "org">>(
  all: readonly T[],
  one: T,
): T[] {
  return all.filter(
    (d) => d.kind === one.kind && d.task === one.task && (d.task !== undefined || d.org === one.org),
  );
}
