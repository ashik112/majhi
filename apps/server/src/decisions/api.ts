import type { McpServerSpec } from "@majhi/acp";
import type { DecideRequestInput, DecisionRecord, DecisionResult, ProviderId } from "@majhi/shared";
import type { Difficulty, TaskBrief } from "../runs/difficulty.ts";

/**
 * What the run manager asks of the decision provider (SPEC 5.12). The decision
 * work implements it; until then `noDecisions` keeps runs working unchanged.
 */

export interface RateTaskRequest extends TaskBrief {
  task: string;
  agent: string;
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
  decide(
    request: DecideRequestInput,
    use: { use: DecisionRecord["use"]; task?: string; agent?: string },
  ): Promise<DecisionResult | undefined>;
}

/** Used until the decision provider is wired: never picks, attaches nothing. */
export const noDecisions: Decisions = {
  rateTask: async () => undefined,
  attachTool: () => undefined,
  revoke: () => {},
  decide: async () => undefined,
};
