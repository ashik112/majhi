import {
  type ApprovalMode,
  type CommandOutput,
  detectSecrets,
  MIN_CONTEXT_CAP,
  type RiskClass,
  type RoomItem,
  type Settings,
} from "@majhi/shared";
import { formatAgo } from "../../lib/format";

export type ApprovalItem = Extract<RoomItem, { type: "approval" }>;
export type SecretRequestItem = Extract<RoomItem, { type: "secret-request" }>;

export const RISK_LABEL: Record<RiskClass, string> = {
  read: "Read",
  change: "Change",
  destructive: "Destructive",
  outbound: "Outbound",
};

export const RISK_TONE: Record<RiskClass, "green" | "amber" | "red" | "blue"> = {
  read: "green",
  change: "amber",
  destructive: "red",
  outbound: "blue",
};

/** What a settled card says, or undefined while it waits for the owner. */
export function approvalOutcome(item: ApprovalItem): string | undefined {
  switch (item.state) {
    case "pending":
      return undefined;
    case "applied":
      return "Applied";
    case "rejected":
      return "Rejected";
    case "failed":
      return "Failed";
    case "undone":
      return "Undone";
  }
}

/** An applied change that made a config commit can be undone from its card. */
export function canUndo(item: ApprovalItem): boolean {
  return item.state === "applied" && item.commit !== undefined;
}

/** True when the composer text holds something that looks like a secret. */
export function looksLikeSecret(text: string): boolean {
  return text.length <= 100_000 && detectSecrets(text).length > 0;
}

export const SECRET_WARNING =
  "This looks like a secret. It will be saved and the agent gets only a reference.";

// History -------------------------------------------------------------------

export type HistoryEntryView = CommandOutput<"history.list">[number];

export interface HistoryRow {
  commit: string;
  who: string;
  what: string;
  reason: string | undefined;
  when: string;
  undone: boolean;
  canUndo: boolean;
}

export function historyRow(entry: HistoryEntryView, now: number): HistoryRow {
  const who =
    entry.actor === "owner" ? "You" : entry.actor === "manual" ? "Edited by hand" : `@${entry.actor}`;
  return {
    commit: entry.commit,
    who,
    what: entry.summary,
    reason: entry.reason,
    when: formatAgo(entry.at, now),
    undone: entry.undone,
    canUndo: !entry.undone && entry.command !== "history.undo",
  };
}

// Settings ------------------------------------------------------------------

/** The settings form holds text, so a half-typed number stays as typed. Percentages are whole numbers. */
export interface SettingsForm {
  /** In thousands of tokens; 0 is no cap. */
  contextCap: string;
  compactAt: string;
  compactTarget: string;
  maxTurns: string;
  agentsMax: string;
  perAccount: string;
  perTask: string;
  idleTimeout: string;
  resumeAuto: boolean;
  resumeHandoff: boolean;
  commitsAttribution: boolean;
  maxAgentTurns: string;
  reviewRounds: string;
  /** Turn limits (PRV-96): each on or off, with its value kept while off. */
  turnLengthOn: boolean;
  turnLength: string;
  turnIdleOn: boolean;
  turnIdle: string;
  turnToolsOn: boolean;
  turnTools: string;
}

/** The fields of the form that are switches. */
export type SettingsSwitch =
  | "resumeAuto"
  | "resumeHandoff"
  | "commitsAttribution"
  | "turnLengthOn"
  | "turnIdleOn"
  | "turnToolsOn";

/** What a limit's field shows while it is off, so turning it on starts from the default. */
const TURN_DEFAULTS = { length: "2h", idle: "25m", tools: "300" } as const;

const percent = (fraction: number) => String(Math.round(fraction * 100));

export function formFromSettings(s: Settings): SettingsForm {
  return {
    contextCap: String(s.context.cap / 1000),
    compactAt: percent(s.context.compact_at),
    compactTarget: percent(s.context.compact_target),
    maxTurns: String(s.context.max_turns),
    agentsMax: String(s.limits.agents_max),
    perAccount: String(s.limits.per_account),
    perTask: String(s.limits.per_task),
    idleTimeout: s.limits.idle_timeout,
    resumeAuto: s.resume.auto,
    resumeHandoff: s.resume.handoff,
    commitsAttribution: s.commits.attribution,
    maxAgentTurns: String(s.rooms.max_agent_turns),
    reviewRounds: String(s.rooms.review_rounds),
    turnLengthOn: s.turns.max_length !== "off",
    turnLength: s.turns.max_length === "off" ? TURN_DEFAULTS.length : s.turns.max_length,
    turnIdleOn: s.turns.idle !== "off",
    turnIdle: s.turns.idle === "off" ? TURN_DEFAULTS.idle : s.turns.idle,
    turnToolsOn: s.turns.max_tool_calls > 0,
    turnTools: s.turns.max_tool_calls > 0 ? String(s.turns.max_tool_calls) : TURN_DEFAULTS.tools,
  };
}

export type SettingsPatch = {
  context?: { cap?: number; compact_at?: number; compact_target?: number; max_turns?: number };
  limits?: { agents_max?: number; per_account?: number; per_task?: number; idle_timeout?: string };
  resume?: { auto?: boolean; handoff?: boolean };
  commits?: { attribution?: boolean };
  rooms?: { max_agent_turns?: number; review_rounds?: number };
  turns?: { max_length?: string; idle?: string; max_tool_calls?: number };
};

export type SettingsErrors = Partial<Record<keyof SettingsForm, string>>;

function whole(text: string, min: number, max: number, what: string): { value?: number; error?: string } {
  if (!/^\d+$/.test(text.trim())) return { error: `${what} must be a whole number` };
  const value = Number(text);
  if (value < min || value > max) return { error: `${what} must be between ${min} and ${max}` };
  return { value };
}

/** The cap in thousands of tokens as typed: 0 for no cap, else at least 20. Returns tokens. */
export function capFromField(text: string): { value?: number; error?: string } {
  const k = whole(text, 0, 10_000, "Context cap");
  if (k.value === undefined) return k;
  if (k.value !== 0 && k.value * 1000 < MIN_CONTEXT_CAP) {
    return { error: `Use 0 for no cap, or at least ${MIN_CONTEXT_CAP / 1000}` };
  }
  return { value: k.value * 1000 };
}

/**
 * The fields of the form that differ from the current settings, as a `settings.set` input, and the
 * problems that stop it from being saved.
 */
export function patchFromForm(
  current: Settings,
  form: SettingsForm,
): { patch: SettingsPatch; errors: SettingsErrors } {
  const errors: SettingsErrors = {};
  const patch: SettingsPatch = {};
  const context: NonNullable<SettingsPatch["context"]> = {};
  const limits: NonNullable<SettingsPatch["limits"]> = {};

  const cap = capFromField(form.contextCap);
  const at = whole(form.compactAt, 1, 99, "Compact at");
  const target = whole(form.compactTarget, 1, 99, "Target after compaction");
  const turns = whole(form.maxTurns, 0, 10_000, "Turns before a fresh session");
  const agents = whole(form.agentsMax, 1, 64, "Agents at once");
  const account = whole(form.perAccount, 1, 16, "Per account");
  const task = whole(form.perTask, 1, 16, "Per task");
  const agentTurns = whole(form.maxAgentTurns, 1, 200, "Agent turns without you");
  const rounds = whole(form.reviewRounds, 1, 50, "Review rounds");
  if (agentTurns.error) errors.maxAgentTurns = agentTurns.error;
  if (rounds.error) errors.reviewRounds = rounds.error;
  if (cap.error) errors.contextCap = cap.error;
  if (at.error) errors.compactAt = at.error;
  if (target.error) errors.compactTarget = target.error;
  if (turns.error) errors.maxTurns = turns.error;
  if (agents.error) errors.agentsMax = agents.error;
  if (account.error) errors.perAccount = account.error;
  if (task.error) errors.perTask = task.error;
  if (at.value !== undefined && target.value !== undefined && target.value >= at.value) {
    errors.compactTarget = "The target must be lower than the compact level";
  }
  const idle = form.idleTimeout.trim();
  if (!/^[1-9][0-9]*(s|m|h)$/.test(idle)) errors.idleTimeout = "Use a number and s, m or h, like 10m";

  if (cap.value !== undefined && cap.value !== current.context.cap) context.cap = cap.value;
  if (at.value !== undefined && at.value / 100 !== current.context.compact_at)
    context.compact_at = at.value / 100;
  if (target.value !== undefined && target.value / 100 !== current.context.compact_target) {
    context.compact_target = target.value / 100;
  }
  if (turns.value !== undefined && turns.value !== current.context.max_turns) context.max_turns = turns.value;
  if (agents.value !== undefined && agents.value !== current.limits.agents_max)
    limits.agents_max = agents.value;
  if (account.value !== undefined && account.value !== current.limits.per_account) {
    limits.per_account = account.value;
  }
  if (task.value !== undefined && task.value !== current.limits.per_task) limits.per_task = task.value;
  if (!errors.idleTimeout && idle !== current.limits.idle_timeout) limits.idle_timeout = idle;
  if (Object.keys(context).length > 0) patch.context = context;
  if (Object.keys(limits).length > 0) patch.limits = limits;
  const resume: NonNullable<SettingsPatch["resume"]> = {};
  if (form.resumeAuto !== current.resume.auto) resume.auto = form.resumeAuto;
  if (form.resumeHandoff !== current.resume.handoff) resume.handoff = form.resumeHandoff;
  if (Object.keys(resume).length > 0) patch.resume = resume;
  if (form.commitsAttribution !== current.commits.attribution)
    patch.commits = { attribution: form.commitsAttribution };
  const rooms: NonNullable<SettingsPatch["rooms"]> = {};
  if (agentTurns.value !== undefined && agentTurns.value !== current.rooms.max_agent_turns) {
    rooms.max_agent_turns = agentTurns.value;
  }
  if (rounds.value !== undefined && rounds.value !== current.rooms.review_rounds)
    rooms.review_rounds = rounds.value;
  if (Object.keys(rooms).length > 0) patch.rooms = rooms;

  const turnsPatch: NonNullable<SettingsPatch["turns"]> = {};
  const duration = /^[1-9][0-9]*(s|m|h)$/;
  const length = form.turnLength.trim();
  const quiet = form.turnIdle.trim();
  if (form.turnLengthOn && !duration.test(length)) errors.turnLength = "Use a number and s, m or h, like 2h";
  if (form.turnIdleOn && !duration.test(quiet)) errors.turnIdle = "Use a number and s, m or h, like 25m";
  const tools = form.turnToolsOn ? whole(form.turnTools, 1, 100_000, "Tool calls") : { value: 0 };
  if (tools.error) errors.turnTools = tools.error;
  const nextLength = form.turnLengthOn ? length : "off";
  const nextIdle = form.turnIdleOn ? quiet : "off";
  if (!errors.turnLength && nextLength !== current.turns.max_length) turnsPatch.max_length = nextLength;
  if (!errors.turnIdle && nextIdle !== current.turns.idle) turnsPatch.idle = nextIdle;
  if (tools.value !== undefined && tools.value !== current.turns.max_tool_calls)
    turnsPatch.max_tool_calls = tools.value;
  if (Object.keys(turnsPatch).length > 0) patch.turns = turnsPatch;
  return { patch, errors };
}

export const MODE_LABEL: Record<ApprovalMode, string> = {
  auto: "Run without asking",
  "when-asked": "Run when I asked for it",
  confirm: "Always ask me",
};
