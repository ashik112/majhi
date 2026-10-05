import type { AgentFrontmatter } from "@majhi/shared";
import { ADMIN_TOOL_ID, getsAdminTools } from "../admin/access.ts";
import { DECIDE_SERVER_NAME } from "../decisions/service.ts";
import {
  CONNECTIONS_SERVER_NAME,
  CONTAINERS_SERVER_NAME,
  MEMORY_SERVER_NAME,
  PROCESSES_SERVER_NAME,
  ROOM_SERVER_NAME,
  SKILLS_SERVER_NAME,
  TASKS_SERVER_NAME,
} from "./access.ts";

/** Serena, the symbol-level code tools (SPEC 5.9 item 6). */
export const SERENA_SERVER_NAME = "serena";

/** Every MCP server majhi can attach to a session, by the name an agent file lists in `tools`. */
export const GATED_TOOLS = [
  ADMIN_TOOL_ID,
  DECIDE_SERVER_NAME,
  ROOM_SERVER_NAME,
  TASKS_SERVER_NAME,
  PROCESSES_SERVER_NAME,
  MEMORY_SERVER_NAME,
  CONTAINERS_SERVER_NAME,
  SERENA_SERVER_NAME,
  CONNECTIONS_SERVER_NAME,
  SKILLS_SERVER_NAME,
] as const;
export type GatedTool = (typeof GATED_TOOLS)[number];

/** Roles that change code, and so get Serena unless the agent turns it off. */
const CODE_ROLES: ReadonlySet<string> = new Set(["Builder"]);

/** What the attachment rules need to know about the session besides the agent. */
export interface GateContext {
  /** The captain: has every command through majhi-admin and no majhi-tasks. */
  boss: string | undefined;
  teamSize: number;
  /** The agent is the first of a lead-mode task that is not a chat. */
  soloLead: boolean;
  /** majhi can run containers (PRV-53). */
  containersOn: boolean;
  /** Serena can start in this session's runner; undefined when it cannot (no runner container). */
  serena: boolean;
  /** The task has repos with a worktree to change. */
  hasWorktrees: boolean;
  /** The task is an `ops` task: its agents can make fix tasks (5.15) without being leads. */
  opsTask?: boolean;
  /** The run holds a connection (5.14). */
  holdsConnections?: boolean;
  /** The run has skills the CLI cannot list itself: it looks them up with majhi-skills. */
  skillsFind?: boolean;
}

type GateAgent = Pick<AgentFrontmatter, "id" | "role" | "scope" | "tools">;

/**
 * In an agent's `tools` list a bare name adds a server the role does not get by default
 * (`majhi-room`, `majhi-tasks`, `majhi-admin` for a root agent, `serena`), and a name with a
 * leading dash, like `-majhi-decide`, takes a default away. The captain keeps `majhi-admin`.
 */
export const OFF_PREFIX = "-";

/** The names the agent's file turns off. */
export function turnedOff(tools: readonly string[]): Set<string> {
  return new Set(tools.filter((t) => t.startsWith(OFF_PREFIX)).map((t) => t.slice(OFF_PREFIX.length)));
}

/**
 * The MCP servers a session gets: the role defaults plus the agent's `tools`, less what it turns
 * off. One place for the rules (SPEC 5.9 item 5), so every run records what it attached.
 *
 * Defaults, kept as they were before gating:
 * - `majhi-admin`: the captain, and a root agent that lists it.
 * - `majhi-decide`: only when the agent lists it (0 calls in five days of use, and its schema sits in every session's context).
 * - `majhi-processes`, `majhi-memory`: every session.
 * - `majhi-room`: a team of two or more, a lone lead of a lead-mode task, or listed.
 * - `majhi-tasks`: leads and root agents, and every agent of an ops task (not the captain), or listed.
 * - `majhi-containers`: every session, when majhi can run containers.
 * - `serena`: builders of a task with worktrees, when it can start; or listed, with worktrees.
 * - `majhi-skills`: a session whose CLI does not list skills itself (not Claude Code in a runner) and that has some.
 * - `majhi-connections`: every session that holds a connection, and root agents, which can attach one.
 */
export function gateTools(agent: GateAgent, ctx: GateContext): GatedTool[] {
  const off = turnedOff(agent.tools);
  const listed = (name: string) => agent.tools.includes(name);
  const lead = agent.role === "Lead" || agent.scope === "root";
  const defaults: Record<GatedTool, boolean> = {
    [ADMIN_TOOL_ID]: getsAdminTools(agent, ctx.boss),
    [DECIDE_SERVER_NAME]: listed(DECIDE_SERVER_NAME),
    [ROOM_SERVER_NAME]: ctx.teamSize > 1 || ctx.soloLead || listed(ROOM_SERVER_NAME),
    [TASKS_SERVER_NAME]: agent.id !== ctx.boss && (lead || ctx.opsTask === true || listed(TASKS_SERVER_NAME)),
    [PROCESSES_SERVER_NAME]: true,
    [MEMORY_SERVER_NAME]: true,
    [CONTAINERS_SERVER_NAME]: ctx.containersOn,
    [SERENA_SERVER_NAME]:
      ctx.serena && ctx.hasWorktrees && (CODE_ROLES.has(agent.role) || listed(SERENA_SERVER_NAME)),
    [CONNECTIONS_SERVER_NAME]: ctx.holdsConnections === true || agent.scope === "root",
    [SKILLS_SERVER_NAME]: ctx.skillsFind === true,
  };
  return GATED_TOOLS.filter((name) => {
    // The captain without majhi-admin could not do its job: a dash cannot take it away.
    if (name === ADMIN_TOOL_ID && agent.id === ctx.boss) return defaults[name];
    return defaults[name] && !off.has(name);
  });
}
