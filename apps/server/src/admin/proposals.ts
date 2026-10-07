import {
  AUTHORITY_ROWS,
  AUTHORITY_SHORT,
  type AuthorityRow,
  type AutonomyMode,
  AutonomyPatchSchema,
  type AutonomySettings,
  AutonomyStartInputSchema,
  type ChatRoomSettings,
  ChatSettingsInputSchema,
  HOLD_CLASSES,
  HOLD_LABEL,
  type DeployEnvironment,
  SetEnvironmentsInputSchema,
} from "@majhi/shared";
import { mergePatch } from "../autonomy/configure.ts";
import { authorityOf } from "../captain/levels.ts";
import { environmentsProblem } from "../deploy/rails.ts";

/**
 * What the captain proposes instead of doing (it may never widen its own power): the plain diff the owner
 * sees, and the basis it was measured against so a stale proposal is never applied. Pure over a small world.
 */

export interface ProposalWorld {
  autonomy(): Promise<AutonomySettings>;
  mode(): AutonomyMode;
  /** A project's workspace and environments, or undefined when it does not exist. */
  project(id: string): Promise<{ org: string; deploy: readonly DeployEnvironment[] } | undefined>;
  orgName(org: string): Promise<string>;
  /** A client chat's workspace, name and settings, or undefined when there is no such linked chat. */
  chatSettings(room: string): Promise<{ org: string; title: string; settings: ChatRoomSettings } | undefined>;
}

export type Planned =
  | { kind: "run" }
  | { kind: "refuse"; error: string }
  | { kind: "propose"; summary: string; basis: string; changes: string[] };

export const PROPOSED_TEXT = "Proposed to the owner; nothing changed yet";

const who = (choice: "decide" | "ask"): string => (choice === "decide" ? "Captain" : "You");

/** JSON with sorted keys, so two reads of the same setting compare equal. */
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canon(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const FIELD_WORD: Record<string, string> = {
  cap: "Daily budget",
  hours: "Work hours",
  freeze: "Freeze",
  tz: "Time zone",
  branches: "Branches",
  providers: "Providers",
  account: "Account",
  fullAccess: "Full access",
  tasksAtOnce: "Tasks at once",
  ships: "Ship rules",
};

function show(value: unknown): string {
  if (value === undefined || value === null) return "none";
  if (value === true) return "on";
  if (value === false) return "off";
  const text = typeof value === "string" ? value : canon(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

const LEGACY_KEYS = new Set(["authority", "level", "push", "merge"]);

function orgChanges(
  current: AutonomySettings,
  next: AutonomySettings,
  org: string,
): { rows: { row: AuthorityRow; to: "decide" | "ask" }[]; lines: string[]; other: number } {
  const before = authorityOf(current, org);
  const after = authorityOf(next, org);
  const rows: { row: AuthorityRow; to: "decide" | "ask" }[] = [];
  const lines: string[] = [];
  for (const row of AUTHORITY_ROWS) {
    if (before[row] === after[row]) continue;
    rows.push({ row, to: after[row] });
    lines.push(`${rowName(row)}: ${who(before[row])} → ${who(after[row])}`);
  }
  const was = (current.orgs[org] ?? {}) as Record<string, unknown>;
  const will = (next.orgs[org] ?? {}) as Record<string, unknown>;
  let other = 0;
  for (const key of new Set([...Object.keys(was), ...Object.keys(will)])) {
    if (LEGACY_KEYS.has(key) || canon(was[key]) === canon(will[key])) continue;
    other += 1;
    lines.push(`${FIELD_WORD[key] ?? key}: ${show(was[key])} → ${show(will[key])}`);
  }
  return { rows, lines, other };
}

function rowName(row: AuthorityRow): string {
  const text = AUTHORITY_SHORT[row];
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function planConfigure(world: ProposalWorld, input: unknown, lane: string): Promise<Planned> {
  const parsed = AutonomyPatchSchema.safeParse(input);
  if (!parsed.success) return { kind: "refuse", error: `Invalid input for autonomy.configure.` };
  const patch = parsed.data;
  const named = Object.keys(patch.orgs ?? {});
  const global = Object.keys(patch).filter((k) => k !== "orgs");
  if (named.length === 0 || named.some((id) => id !== lane) || global.length > 0) {
    return {
      kind: "refuse",
      error: `The captain proposes changes to its own workspace only: put them under orgs.${lane} and nothing else.`,
    };
  }
  const current = await world.autonomy();
  let next: AutonomySettings;
  try {
    next = mergePatch(current, patch);
  } catch {
    return { kind: "refuse", error: "That change is not valid for autonomous mode's settings." };
  }
  const { rows, lines, other } = orgChanges(current, next, lane);
  const gone = patch.orgs?.[lane] === null && lines.length === 0 && current.orgs[lane] !== undefined;
  if (lines.length === 0 && !gone) return { kind: "refuse", error: "That would change nothing." };
  const name = await world.orgName(lane);
  const toCaptain = rows.filter((r) => r.to === "decide").map((r) => AUTHORITY_SHORT[r.row]);
  const toYou = rows.filter((r) => r.to === "ask").map((r) => AUTHORITY_SHORT[r.row]);
  const parts = [
    ...(toCaptain.length > 0 ? [`captain decides ${toCaptain.join(", ")}`] : []),
    ...(toYou.length > 0 ? [`you decide ${toYou.join(", ")}`] : []),
    ...(other > 0 ? [rows.length === 0 ? "change captain settings" : "more settings"] : []),
    ...(gone ? ["reset captain settings"] : []),
  ];
  return {
    kind: "propose",
    summary: `${name}: ${parts.join("; ")}`.slice(0, 280),
    basis: await configureBasis(world, lane),
    changes: gone && lines.length === 0 ? ["Captain settings: reset to the defaults"] : lines,
  };
}

async function configureBasis(world: ProposalWorld, lane: string): Promise<string> {
  const current = await world.autonomy();
  return canon({ orgs: { [lane]: current.orgs[lane] ?? null } });
}

function planStart(world: ProposalWorld, input: unknown): Planned {
  const parsed = AutonomyStartInputSchema.safeParse(input);
  if (!parsed.success) return { kind: "refuse", error: "Invalid input for autonomy.start." };
  if (world.mode() === "on" && !parsed.data.resumeStopped) {
    return { kind: "refuse", error: "Autonomous is already on." };
  }
  return {
    kind: "propose",
    summary: "Turn Autonomous on",
    basis: startBasis(world),
    changes: [
      `Autonomous: ${world.mode() === "on" ? "On" : "Off"} → On`,
      ...(parsed.data.resumeStopped ? ["Resume the tasks it paused"] : []),
    ],
  };
}

function startBasis(world: ProposalWorld): string {
  return world.mode();
}

function envChanges(
  before: readonly DeployEnvironment[],
  after: readonly DeployEnvironment[],
): { lines: string[]; phrases: string[] } {
  const lines: string[] = [];
  const phrases: string[] = [];
  const was = new Map(before.map((e) => [e.env, e]));
  const will = new Map(after.map((e) => [e.env, e]));
  for (const [env, e] of will) {
    const old = was.get(env);
    if (old === undefined) {
      lines.push(`${env}: added (${e.tier})`);
      phrases.push(`add ${env}`);
      continue;
    }
    if (old.tier !== e.tier) {
      lines.push(`${env}: ${old.tier} → ${e.tier}`);
      phrases.push(`set ${env} to ${e.tier}`);
    }
    if (old.branch !== e.branch) lines.push(`${env} branch: ${show(old.branch)} → ${show(e.branch)}`);
    if (old.check !== e.check) lines.push(`${env} check: ${show(old.check)} → ${show(e.check)}`);
  }
  for (const [env, e] of was) {
    if (will.has(env)) continue;
    lines.push(`${env}: removed (${e.tier})`);
    phrases.push(`remove ${env}`);
  }
  return { lines, phrases };
}

async function planEnvironments(world: ProposalWorld, input: unknown, lane: string): Promise<Planned> {
  const parsed = SetEnvironmentsInputSchema.safeParse(input);
  if (!parsed.success) return { kind: "refuse", error: "Invalid input for projects.setEnvironments." };
  const { project, environments } = parsed.data;
  const info = await world.project(project);
  if (info === undefined) return { kind: "refuse", error: `Project "${project}" does not exist.` };
  if (info.org !== lane) {
    return { kind: "refuse", error: `Project "${project}" belongs to another workspace.` };
  }
  // What the captain may do on its own runs as today: only what its rail refuses becomes a proposal.
  if (environmentsProblem(info.deploy, environments, "captain") === undefined) return { kind: "run" };
  const { lines, phrases } = envChanges(info.deploy, environments);
  return {
    kind: "propose",
    summary: `${project}: ${phrases.join(", ")}`.slice(0, 280),
    basis: canon(info.deploy),
    changes: lines,
  };
}

const CHAT_WORD: Record<string, string> = {
  replyWhen: "Reply when",
  dailyLimit: "Replies a day",
  rules: "Rules",
  keep: "Keep",
  notify: "Notify me",
};

const askWord = (value: boolean | undefined): string =>
  value === undefined ? "workspace" : value ? "ask me" : "captain";

async function planChatSettings(world: ProposalWorld, input: unknown, lane: string): Promise<Planned> {
  const parsed = ChatSettingsInputSchema.safeParse(input);
  if (!parsed.success) return { kind: "refuse", error: "Invalid input for chat.settingsSet." };
  const found = await world.chatSettings(parsed.data.room);
  if (found === undefined) return { kind: "refuse", error: "There is no such linked client chat." };
  if (found.org !== lane) {
    return { kind: "refuse", error: "That chat belongs to another workspace; the captain proposes for its own only." };
  }
  const lines: string[] = [];
  for (const key of ["replyWhen", "dailyLimit", "rules", "keep", "notify"] as const) {
    const next = parsed.data[key];
    if (next === undefined || canon(next) === canon(found.settings[key])) continue;
    lines.push(`${CHAT_WORD[key]}: ${show(found.settings[key])} → ${show(next)}`);
  }
  for (const kind of HOLD_CLASSES) {
    const next = parsed.data.holds?.[kind];
    if (next === undefined) continue;
    const was = found.settings.holds[kind];
    if ((next ?? undefined) === was) continue;
    lines.push(`Ask me, ${HOLD_LABEL[kind].toLowerCase()}: ${askWord(was)} → ${askWord(next ?? undefined)}`);
  }
  if (lines.length === 0) return { kind: "refuse", error: "That would change nothing." };
  return {
    kind: "propose",
    summary: `${found.title}: change chat settings`.slice(0, 280),
    basis: canon(found.settings),
    changes: lines,
  };
}

/**
 * What a captain's call to a proposable command becomes: `run` (its own rail allows it, the normal path
 * carries on), `refuse` (outside its workspace or invalid), or `propose` (stored for the owner).
 */
export async function planProposal(
  world: ProposalWorld,
  command: string,
  input: unknown,
  lane: string,
): Promise<Planned> {
  switch (command) {
    case "autonomy.configure":
      return planConfigure(world, input, lane);
    case "autonomy.start":
      return planStart(world, input);
    case "projects.setEnvironments":
      return planEnvironments(world, input, lane);
    case "chat.settingsSet":
      return planChatSettings(world, input, lane);
    default:
      return { kind: "refuse", error: `${command} cannot be proposed.` };
  }
}

/**
 * What a stored proposal is measured against now, to compare with the basis it carries. Undefined when it
 * cannot be read (the project is gone): the proposal is then stale.
 */
export async function proposalBasis(
  world: ProposalWorld,
  command: string,
  input: unknown,
  lane: string,
): Promise<string | undefined> {
  switch (command) {
    case "autonomy.configure":
      return configureBasis(world, lane);
    case "autonomy.start":
      return startBasis(world);
    case "projects.setEnvironments": {
      const parsed = SetEnvironmentsInputSchema.safeParse(input);
      if (!parsed.success) return undefined;
      const info = await world.project(parsed.data.project);
      return info === undefined ? undefined : canon(info.deploy);
    }
    case "chat.settingsSet": {
      const parsed = ChatSettingsInputSchema.safeParse(input);
      if (!parsed.success) return undefined;
      const found = await world.chatSettings(parsed.data.room);
      return found === undefined ? undefined : canon(found.settings);
    }
    default:
      return undefined;
  }
}
