import type { CoordinationMode, HandoffVia, Role } from "@majhi/shared";
import { OWNER_HANDLE } from "@majhi/shared";
import type { RoomState } from "./state.ts";

/**
 * Who works next when an agent ends its turn (SPEC 5.3). Pure: the coordinator reads the task,
 * the settings and the agent's message, and applies the plan this returns.
 */

export interface Member {
  id: string;
  role: Role;
}

/** A reviewer's reply, read from its message (`verdictOf`) or asked of the decision provider. */
export type Verdict = "approved" | "changes" | "unclear";

export interface TurnEnd {
  mode: CoordinationMode;
  /** The task's team, lead first. */
  team: readonly Member[];
  /** The agent whose turn ended. */
  from: string;
  /** Agents its last message mentions, in order, `owner` included. Never `from` itself. */
  mentions: readonly string[];
  state: RoomState;
  limits: { maxAgentTurns: number; reviewRounds: number };
  /** For a reviewer: what it said about the work (always in the review loop, in lead mode when it woke nobody). */
  verdict?: Verdict | undefined;
  /** The owner has a question pending and this turn changed nothing and only waits: nobody is woken. */
  waiting?: boolean | undefined;
}

export interface Plan {
  handoffs: { to: string; via: HandoffVia }[];
  state: RoomState;
  /** The loop guard or the round cap stopped the room: pause the task and say this. */
  pause?: string;
  /** The loop guard's first trip: wake only the lead with this note instead of pausing. */
  nudge?: { to: string; text: string };
  /** The work goes back to the owner: it was approved, the pipeline finished, or someone asked for them. */
  toOwner?: string;
}

/** Pipeline order (5.3): lead, builders, reviewer, tester. Root agents work with the builders. */
const STAGE_OF: Record<Role, number> = { Lead: 0, Builder: 1, Root: 1, Reviewer: 2, Tester: 3 };

/** The pipeline's stages in order, each the agents of one role, empty stages left out. */
export function pipelineStages(team: readonly Member[]): string[][] {
  const stages: string[][] = [[], [], [], []];
  for (const m of team) stages[STAGE_OF[m.role]]?.push(m.id);
  return stages.filter((s) => s.length > 0);
}

/** The builder and reviewer of the review loop: the first of each role, else the first two agents. */
export function loopPair(team: readonly Member[]): { builder?: string; reviewer?: string } {
  const reviewer = team.find((m) => m.role === "Reviewer")?.id;
  const builder =
    team.find((m) => m.role === "Builder")?.id ??
    team.find((m) => m.id !== reviewer && m.role !== "Tester")?.id;
  return {
    ...(builder === undefined ? {} : { builder }),
    ...(reviewer === undefined ? {} : { reviewer }),
  };
}

/** Who gets the brief when the task starts, and the room state to start from. */
export function firstTurn(
  mode: CoordinationMode,
  team: readonly Member[],
): { agents: string[]; state: RoomState } {
  if (mode === "pipeline") {
    const first = pipelineStages(team)[0] ?? [];
    return { agents: first, state: { agentTurns: 0, stage: 0, pending: first } };
  }
  if (mode === "review-loop") {
    const { builder } = loopPair(team);
    const agents = builder === undefined ? team.slice(0, 1).map((m) => m.id) : [builder];
    return { agents, state: { agentTurns: 0, round: 0 } };
  }
  return { agents: team.slice(0, 1).map((m) => m.id), state: { agentTurns: 0 } };
}

/**
 * The plan after one finished turn. Every handoff counts toward the loop guard; when the next
 * ones would pass `maxAgentTurns` since the owner last wrote, nothing is handed on and the room
 * pauses instead.
 */
export function planTurn(input: TurnEnd): Plan {
  const { mode, team, from, state } = input;
  const inTeam = new Set(team.map((m) => m.id));
  const mentioned = input.mentions.filter((m) => m !== from && inTeam.has(m));
  const ownerAsked = input.mentions.includes(OWNER_HANDLE);
  // Waiting on the owner wakes nobody: the owner's answer starts the room again.
  if (input.waiting === true) return { handoffs: [], state: { ...state } };
  let plan: Plan;
  switch (mode) {
    case "lead":
      plan = {
        handoffs: mentioned.map((to) => ({ to, via: "mention" as const })),
        state: { ...state },
      };
      // The reviewer approved and woke nobody: the lead's work is done, the owner decides.
      if (input.verdict === "approved" && mentioned.length === 0)
        plan.toOwner = `@${from} approved the work.`;
      break;
    case "pipeline":
      plan = pipelineTurn(input, ownerAsked);
      break;
    case "review-loop":
      plan = reviewTurn(input, mentioned);
      break;
  }
  if (ownerAsked && plan.toOwner === undefined) plan.toOwner = `@${from} asked for you.`;
  return guard(plan, input.limits.maxAgentTurns, team[0]?.id);
}

function pipelineTurn(input: TurnEnd, ownerAsked: boolean): Plan {
  const { team, from, state } = input;
  const stages = pipelineStages(team);
  const stage = state.stage ?? 0;
  const current = stages[stage] ?? [];
  // Someone outside the current step (the owner talked to them): the pipeline does not move.
  if (!current.includes(from)) return { handoffs: [], state: { ...state } };
  const pending = (state.pending ?? current).filter((a) => a !== from);
  if (pending.length > 0) return { handoffs: [], state: { ...state, stage, pending } };
  // The owner was asked: the next step waits until the owner answers and the agent ends again.
  if (ownerAsked) return { handoffs: [], state: { ...state, stage, pending: [from] } };
  const next = stages[stage + 1];
  if (next === undefined) {
    return {
      handoffs: [],
      state: { ...state, stage: stage + 1, pending: [] },
      toOwner: "Every step of the pipeline ran.",
    };
  }
  return {
    handoffs: next.map((to) => ({ to, via: "pipeline" as const })),
    state: { ...state, stage: stage + 1, pending: next },
  };
}

function reviewTurn(input: TurnEnd, mentioned: readonly string[]): Plan {
  const { team, from, state, limits } = input;
  const { builder, reviewer } = loopPair(team);
  const round = state.round ?? 0;
  if (builder === undefined || reviewer === undefined) {
    // No pair to alternate between: mentions still work.
    return { handoffs: mentioned.map((to) => ({ to, via: "mention" as const })), state: { ...state } };
  }
  if (from === builder) {
    return { handoffs: [{ to: reviewer, via: "review-loop" }], state: { ...state, round } };
  }
  if (from === reviewer) {
    const verdict = input.verdict ?? "unclear";
    if (verdict === "approved") {
      return { handoffs: [], state: { ...state, round }, toOwner: `@${reviewer} approved the work.` };
    }
    if (verdict === "unclear") {
      return {
        handoffs: [],
        state: { ...state, round },
        toOwner: `@${reviewer} did not say whether the work is approved.`,
      };
    }
    const next = round + 1;
    if (next >= limits.reviewRounds) {
      return {
        handoffs: [],
        state: { ...state, round: next },
        pause: `${next} review rounds without approval. Read the last review, then reply to continue.`,
      };
    }
    return { handoffs: [{ to: builder, via: "review-loop" }], state: { ...state, round: next } };
  }
  // Another member (a lead, a tester) ended: its mentions route as usual.
  return { handoffs: mentioned.map((to) => ({ to, via: "mention" as const })), state: { ...state } };
}

/**
 * The loop guard (5.3): too many agent-to-agent turns that change no files. The first time, only
 * the lead is woken with a note to finish or hand back; if the agents keep going in circles after
 * that, the room pauses.
 */
function guard(plan: Plan, max: number, lead: string | undefined): Plan {
  if (plan.handoffs.length === 0) return plan;
  const turns = plan.state.agentTurns + plan.handoffs.length;
  if (turns > max && plan.state.nudged !== true && lead !== undefined) {
    return {
      handoffs: [],
      state: { ...plan.state, agentTurns: 0, nudged: true },
      nudge: {
        to: lead,
        text: `Loop guard: ${plan.state.agentTurns} handoffs in a row changed no files. Do not answer old process results or status lines. Decide now: finish the remaining work (say who does what, and only mention an agent that must act), or hand the task back to the owner for review. If it keeps going in circles, majhi pauses the task.`,
      },
    };
  }
  if (turns > max) {
    return {
      handoffs: [],
      state: { ...plan.state },
      pause: `${plan.state.agentTurns} more handoffs changed no files after the lead was asked to finish. Paused so agents do not go in circles. Reply to continue.`,
    };
  }
  return { ...plan, state: { ...plan.state, agentTurns: turns } };
}

/**
 * A reviewer's verdict from its own words. The handoff prompt asks it to end with APPROVED or
 * CHANGES NEEDED; other plain phrasings count too. Undefined when the text says neither, so the
 * caller can ask the decision provider.
 */
export function verdictOf(text: string): "approved" | "changes" | undefined {
  const t = text.replace(/`[^`]*`/g, " ");
  if (
    /\b(changes (are )?needed|request(ed|ing)? changes|needs? (a )?fix(es)?|not approved|(do not|don't|cannot|can't) approve)\b/i.test(
      t,
    )
  )
    return "changes";
  if (/\b(approved?|lgtm|looks good to me|ship it)\b/i.test(t)) return "approved";
  return undefined;
}

/** A sentence that says the agent has nothing to do but wait. */
const IDLE =
  /\b(waiting|wait (for|on|until)|standing by|stand by|on hold|idle|nothing (else |more |left |new |further )?(to do|to add|to report|to hand on|for me)|no (further )?(action|work) (needed|for me|from me|on my side))\b/i;
/** Words that turn a waiting sentence into a request: "while we wait, @x please ...". */
const ASKS =
  /\b(please|can you|could you|would you|go ahead|start|pick up|take over|meanwhile|in the meantime|while)\b/i;
const AGENT_MENTION = /(^|[^A-Za-z0-9_@/.-])@(?!owner\b)[A-Za-z0-9][A-Za-z0-9-]*/gi;

/** A sentence that only reports where work stands: something runs, or someone will report. */
const STATUS =
  /\b((is|are) (still )?(running|in progress|under ?way|building|going)|still (running|working|building|checking|reviewing|going|in progress)|in progress|under ?way|will (report|reply|ping|post|follow up|get back|let (you|us|me|everyone) know)|reports? (back )?(to|when|once)|(has|have)( not|n't) (finished|reported|ended)( yet)?|not (done|finished) yet|no (news|update|result) yet)\b/i;
/** Words that ask for work in a sentence that otherwise reports status. */
const WORK =
  /\b(fix|add|change|implement|write|remove|rename|investigate|look (at|into)|re-?run|retry|revert|rebase|merge|commit|push|need(s)? (you|to)|should|must|let's|instead)\b/i;

/**
 * Whether an agent's message only says it is waiting or has nothing to do ("Nothing for me until
 * the owner answers. Standing by, @lead."). A sentence that asks a teammate for something, or
 * mentions one with more to say than a name, makes it more than waiting. Code and quotes are not read.
 */
export function waitsOnly(text: string): boolean {
  return onlySays(text, (s) => IDLE.test(s));
}

/**
 * Like `waitsOnly`, and a sentence that only reports status counts too ("I'm still waiting.
 * @builder's check is running and it reports to @lead."). A mention in it names who the status is
 * about, so it wakes nobody. A sentence that asks for work makes it more than status.
 */
export function statusOnly(text: string): boolean {
  return onlySays(text, (s) => IDLE.test(s) || (STATUS.test(s) && !WORK.test(s)));
}

/** Whether every sentence is `idle` or a bare mention, and at least one is `idle`. */
function onlySays(text: string, idle: (sentence: string) => boolean): boolean {
  const sentences = plainText(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  let said = false;
  for (const s of sentences) {
    const mentions = s.match(AGENT_MENTION) !== null;
    if (idle(s)) {
      if (mentions && ASKS.test(s)) return false;
      said = true;
      continue;
    }
    // A bare mention ("@lead.") names who it waits on; anything more to a teammate is a request.
    if (mentions && /[A-Za-z0-9]/.test(s.replace(AGENT_MENTION, " "))) return false;
  }
  return said;
}

/**
 * Whether the worktrees changed since the last turn of the lead or a reviewer: a teammate committed
 * or edited and nobody has reviewed it. In lead mode the lead reviews and integrates that work
 * before the task can go to review. False when either state is unknown.
 */
export function unreviewed(state: Pick<RoomState, "fingerprint" | "reviewedFingerprint">): boolean {
  return (
    state.fingerprint !== undefined &&
    state.reviewedFingerprint !== undefined &&
    state.fingerprint !== state.reviewedFingerprint
  );
}

/** Whether `planTurn` hands work to the agents a message from `from` mentions. */
export function routesMentions(mode: CoordinationMode, team: readonly Member[], from: string): boolean {
  if (mode === "lead") return true;
  if (mode === "pipeline") return false;
  const { builder, reviewer } = loopPair(team);
  return builder === undefined || reviewer === undefined || (from !== builder && from !== reviewer);
}

/** The text an agent wrote itself: no code, no quoted lines. */
export function plainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}

/**
 * Whether an agent's message asks the owner for something, from its words alone: a question that
 * is not addressed to another agent, or a plain request for a decision. Code and quotes are not
 * read. The decision model is not asked: on Laya no wording of this question was reliable.
 */
export function asksOwner(text: string): boolean {
  return ownerQuestion(text) !== undefined;
}

/**
 * The words that ask the owner something, or undefined. Only the message's last paragraph counts:
 * a status report with a question in the middle ("did the name resolve? It does now.") asks nothing.
 * Questions in parentheses, code and quotes are not read, nor ones addressed to another agent.
 */
export function ownerQuestion(text: string): string | undefined {
  const t = plainText(text).replace(/\([^)]*\)/g, " ");
  if (/(^|\s)@owner\b/i.test(t)) return lastParagraph(t);
  const last = lastParagraph(t);
  if (
    /\b(let me know|please (confirm|decide|approve|advise|choose)|your (call|decision|approval|go-ahead))\b/i.test(
      last,
    )
  )
    return last;
  const questions = (last.match(/[^.!?\n]*\?/g) ?? [])
    .map((q) => q.trim())
    .filter((q) => q !== "" && !/(^|\s)@(?!owner\b)[a-z0-9][a-z0-9-]*/i.test(q));
  return questions.length === 0 ? undefined : questions.join(" ");
}

function lastParagraph(text: string): string {
  const parts = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  return (parts.at(-1) ?? "").slice(0, 600);
}
