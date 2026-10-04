import type { McpServerSpec } from "@majhi/acp";
import type {
  DecideRequestInput,
  DecisionOutcome,
  DecisionRecord,
  DecisionResult,
  LinkKind,
  ProviderId,
} from "@majhi/shared";
import type { Difficulty, TaskBrief } from "../runs/difficulty.ts";
import type { TaskOutcome } from "./labels.ts";

/**
 * What the run manager asks of the decision provider (SPEC 5.12). The decision
 * work implements it; until then `noDecisions` keeps runs working unchanged.
 */

export interface RateTaskRequest extends TaskBrief {
  /** Absent for a task not made yet (autonomous mode sizing a task it would create). */
  task?: string | undefined;
  agent?: string | undefined;
  /** What the rating is for, as the decision log shows it. Default `model-pick`. */
  use?: "model-pick" | "task-size";
}

/** How much work the provider says a task is, whether or not it counts. The caller applies the bar. */
export interface TaskRating {
  /** The level it gave, or undefined when it answered that no level fits. */
  level?: Difficulty;
  /** The probability of that answer. */
  confidence: number;
  /** True when the answer is sure enough to use. */
  counted: boolean;
  /** Why it counted or not, in plain words: "0.31, under the 0.40 floor". */
  why: string;
  /** The decision's id in the log, for the run record. */
  decisionId: string;
  provider: ProviderId;
  /** The provider's name as the room says it: "Laya". */
  by: string;
}

/** What a call is for, and how far down the chain it may go. */
export interface DecideUse {
  use: DecisionRecord["use"];
  task?: string;
  agent?: string;
  /**
   * The providers to try, in order, instead of the owner's order (the rules always close it). A cheap
   * frequent call names `["laya"]` so a down Laya never falls through to a paid model.
   */
  order?: readonly ProviderId[];
  /**
   * At most this many answers a day from the first provider of `order`, counted in the decision log
   * (so a restart does not reset it). Over the cap the call resolves undefined: the caller's fallback runs.
   */
  perDay?: number;
}

export interface Decisions {
  /**
   * Asks how much work the task is for the agent's role. Resolves undefined when no provider
   * answers. A pick maps the level to the role's tiers; it never asks about models.
   */
  rateTask(request: RateTaskRequest): Promise<TaskRating | undefined>;
  /**
   * The `majhi-decide` MCP server for one agent session, with a fresh bearer
   * token. Every agent gets it unless its `tools` list opts out. Call `revoke`
   * with the token when the session ends.
   */
  attachTool(task: string, agent: string): { token: string; server: McpServerSpec } | undefined;
  revoke(token: string): void;
  /**
   * Runs the chain on typed questions and records the decision on the task (5.12). Rooms use it
   * for the default team of a new task and a review verdict. Resolves undefined when there is no
   * provider at all.
   */
  decide(request: DecideRequestInput, use: DecideUse): Promise<DecisionResult | undefined>;
  /** Records what majhi did with a decision, for the log and the owner's "Wrong pick". */
  outcome(id: string, outcome: DecisionOutcome): void;
  /** Holds a decision until the outcome of `ref` is known, so the outcome can label it (5.12). */
  link?(kind: LinkKind, ref: string, decisionId: string, question: string): void;
  /** The outcome of `ref` is known: labels the decisions linked to it with `label`, once. */
  resolve?(kind: LinkKind, ref: string, label: string, note?: string): void;
  /** A task reached review with this much done: labels its size decisions with how big it turned out. */
  taskReviewed?(task: string, outcome: TaskOutcome): void;
}

/** Used until the decision provider is wired: never picks, attaches nothing. */
export const noDecisions: Decisions = {
  rateTask: async () => undefined,
  attachTool: () => undefined,
  revoke: () => {},
  decide: async () => undefined,
  outcome: () => {},
};
