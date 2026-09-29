import type { McpServerSpec } from "@majhi/acp";
import type { OptionValue, Role } from "@majhi/shared";

/**
 * What the run manager asks of the decision provider (SPEC 5.12). The decision
 * work implements it; until then `noDecisions` keeps runs working unchanged.
 */

export interface ModelPickRequest {
  task: string;
  agent: string;
  role: Role;
  /** The task brief and the agent's instructions, trimmed by the provider. */
  context: string;
  /** Offered by the account, narrowed to the agent's `models` list when it has one. */
  models: readonly OptionValue[];
  efforts: readonly OptionValue[];
  pickModel: boolean;
  pickEffort: boolean;
  /**
   * Answers below this are dropped. Default: the decision settings' floor. Model picks use 0.4:
   * Laya spreads probability across similar models, so 0.6 rejects most picks.
   */
  minConfidence?: number;
}

export interface ModelPick {
  model?: string;
  effort?: string;
  /** The decision's id in the log, for the room event and the run record. */
  decisionId: string;
  provider: string;
  confidence: number;
  /** One line for the room: "Laya picked sonnet, effort medium (0.82)". */
  reason: string;
}

export interface Decisions {
  /**
   * Picks model and/or effort for an `auto` agent at session start. Resolves
   * undefined when no provider answers or confidence is below the floor; the
   * caller then keeps the agent's ACP default.
   */
  pickModel(request: ModelPickRequest): Promise<ModelPick | undefined>;
  /**
   * The `majhi-decide` MCP server for one agent session, with a fresh bearer
   * token. Every agent gets it unless its `tools` list opts out. Call `revoke`
   * with the token when the session ends.
   */
  attachTool(task: string, agent: string): { token: string; server: McpServerSpec } | undefined;
  revoke(token: string): void;
}

/** Used until the decision provider is wired: never picks, attaches nothing. */
export const noDecisions: Decisions = {
  pickModel: async () => undefined,
  attachTool: () => undefined,
  revoke: () => {},
};
