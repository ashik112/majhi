import {
  type AccountStatus,
  type AgentFrontmatter,
  type CoordinationMode,
  canWorkIn,
  type DecideRequestInput,
  type DecisionResult,
  MODE_LABELS,
  type Role,
  type TaskKind,
} from "@majhi/shared";
import { pickDefaultAgent } from "../tasks/agents.ts";

/** A team a new task could get, in words the decision provider can read. */
export interface TeamOption {
  key: "solo" | "pair" | "full";
  team: string[];
  mode: CoordinationMode;
  /** One line for the question and the room. */
  label: string;
}

/** Account states where a new run would fail at once. */
const UNUSABLE: ReadonlySet<AccountStatus> = new Set(["needs-login", "at-limit", "unreachable"]);

/** Below this the pick is dropped and the rules' team is used (Laya spreads probability, like model picks). */
export const TEAM_MIN_CONFIDENCE = 0.4;

/**
 * The teams a new task can get from the agents that may work in its org (SPEC 5.3, Phase 3):
 * one agent; a builder and a reviewer taking turns; a lead with a builder and a reviewer. The org's
 * agents come before root agents, usable accounts before the rest. The first option is what the
 * rules pick. An org's own `team` in majhi.yaml is the owner's choice and is used without asking.
 */
export function teamOptions(input: {
  agents: readonly AgentFrontmatter[];
  org: string | undefined;
  boss: string | undefined;
  accountStatus: ReadonlyMap<string, AccountStatus>;
}): TeamOption[] {
  const { agents, org } = input;
  const solo = pickDefaultAgent(input);
  if (solo === undefined) return [];
  const options: TeamOption[] = [
    { key: "solo", team: [solo], mode: "lead", label: `one agent: ${who(agents, [solo])}` },
  ];
  const able = agents
    .filter((a) => canWorkIn(a, org) && a.id !== input.boss)
    .sort(
      (a, b) =>
        Number(UNUSABLE.has(input.accountStatus.get(a.account) ?? "unknown")) -
          Number(UNUSABLE.has(input.accountStatus.get(b.account) ?? "unknown")) ||
        Number(b.scope === org) - Number(a.scope === org) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const first = (role: Role) => able.find((a) => a.role === role)?.id;
  const lead = first("Lead");
  const builder = first("Builder");
  const reviewer = first("Reviewer");
  if (builder !== undefined && reviewer !== undefined) {
    options.push({
      key: "pair",
      team: [builder, reviewer],
      mode: "review-loop",
      label: `a builder and a reviewer taking turns: ${who(agents, [builder, reviewer])}`,
    });
    if (lead !== undefined) {
      options.push({
        key: "full",
        team: [lead, builder, reviewer],
        mode: "lead",
        label: `a lead who plans and delegates, with a builder and a reviewer: ${who(agents, [lead, builder, reviewer])}`,
      });
    }
  }
  return options;
}

function who(agents: readonly AgentFrontmatter[], ids: readonly string[]): string {
  return ids.map((id) => `@${id} (${agents.find((a) => a.id === id)?.role ?? "agent"})`).join(", ");
}

/** The question for the decision provider. The state is the brief, the kind and the repos. */
export function teamQuestion(
  brief: { title: string; text: string; kind: TaskKind; repos: readonly string[] },
  options: readonly TeamOption[],
): DecideRequestInput {
  return {
    state: {
      task: brief.text,
      kind: brief.kind,
      repos: brief.repos.length === 0 ? "none" : brief.repos.join(", "),
    },
    questions: {
      team: {
        type: "choice",
        instructions:
          "Which team should do the task? A small, clear change needs one agent. A feature or a fix that should be checked needs a builder and a reviewer. Large or many-part work needs a lead to plan and split it.",
        options: options.map((o) => ({ key: o.key, description: o.label })),
        orders: "shifted",
      },
    },
  };
}

export interface TeamPick {
  option: TeamOption;
  /** The decision, when the provider answered with enough confidence. */
  decision?: { id: string; provider: string; confidence: number };
  /** One line for the room. */
  line: string;
}

const PROVIDER_NAMES: Record<string, string> = {
  laya: "Laya",
  jev: "Jev",
  acp: "The stand-in agent",
  rules: "Rules",
};

/**
 * The provider's pick among the options, or the rules' (the first option) when it did not answer,
 * answered an unknown option, or was not sure enough.
 */
export function chooseTeam(
  options: readonly TeamOption[],
  result: DecisionResult | undefined,
): TeamPick | undefined {
  const fallback = options[0];
  if (fallback === undefined) return undefined;
  const answer = result?.answers.team;
  const picked = options.find((o) => o.key === answer?.value);
  if (
    result !== undefined &&
    answer !== undefined &&
    picked !== undefined &&
    answer.confidence >= TEAM_MIN_CONFIDENCE
  ) {
    const name = PROVIDER_NAMES[result.provider] ?? result.provider;
    return {
      option: picked,
      decision: { id: result.id, provider: result.provider, confidence: answer.confidence },
      line: `${name} picked the team: ${picked.label}. ${MODE_LABELS[picked.mode]} (${answer.confidence.toFixed(2)}${result.estimated ? ", estimated" : ""}).`,
    };
  }
  const why =
    result === undefined
      ? "no decision provider answered"
      : answer === undefined || picked === undefined
        ? "the decision provider gave no usable answer"
        : `the decision provider was not sure (${answer.confidence.toFixed(2)})`;
  return {
    option: fallback,
    line: `Team: ${fallback.label}. ${MODE_LABELS[fallback.mode]}. Picked by the rules: ${why}.`,
  };
}
