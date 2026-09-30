import type { McpServerSpec } from "@majhi/acp";
import type { DecideRequest, DecisionRecord, DecisionResult, ProviderId, Role } from "@majhi/shared";
import type { PickOption } from "../runs/model-options.ts";

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
  /** Models to choose from, merged into families and labelled. Fewer than two: not asked. */
  models: readonly PickOption[];
  /** Efforts to choose from, lowest first. Fewer than two: not asked. */
  efforts: readonly PickOption[];
  /**
   * The models to rank when they have no price: asked in the same call as which is the most capable
   * and which is the cheapest and fastest. Fewer than two: not asked.
   */
  rank?: readonly PickOption[];
}

/** An answer with its confidence, whatever it was. The caller applies the floors. */
export interface PickAnswer {
  id: string;
  confidence: number;
}

export interface ModelPick {
  model?: PickAnswer;
  effort?: PickAnswer;
  /** The model named most capable, and the one named cheapest and fastest, when `rank` was asked. */
  capable?: string;
  cheapest?: string;
  /** The decision's id in the log, for the run record. */
  decisionId: string;
  provider: ProviderId;
  /** The provider's name as the room says it: "Laya". */
  by: string;
}

export interface Decisions {
  /**
   * Asks which model and/or effort fits the role and the task. Answers come back with their
   * confidence, low ones too: the caller applies the floors and the fallback tiers. Resolves
   * undefined when nothing was asked or no provider answers.
   */
  pickModel(request: ModelPickRequest): Promise<ModelPick | undefined>;
  /**
   * The `majhi-decide` MCP server for one agent session, with a fresh bearer
   * token. Every agent gets it unless its `tools` list opts out. Call `revoke`
   * with the token when the session ends.
   */
  attachTool(task: string, agent: string): { token: string; server: McpServerSpec } | undefined;
  revoke(token: string): void;
  /**
   * Runs the chain on typed questions and records the decision on the task (5.12). Rooms use it
   * for the default team of a new task, whether a message needs the owner, and a review verdict.
   * Resolves undefined when there is no provider at all.
   */
  decide(
    request: DecideRequest,
    use: { use: DecisionRecord["use"]; task?: string; agent?: string },
  ): Promise<DecisionResult | undefined>;
}

/** Used until the decision provider is wired: never picks, attaches nothing. */
export const noDecisions: Decisions = {
  pickModel: async () => undefined,
  attachTool: () => undefined,
  revoke: () => {},
  decide: async () => undefined,
};
