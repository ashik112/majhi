import type { AgentEntry, TaskKind, TaskStatus, TaskSummary } from "@majhi/shared";

// Status --------------------------------------------------------------------

/** A running task whose agents all finished their turn: it waits for the owner. */
export function isYourTurn(task: Pick<TaskSummary, "status" | "working">): boolean {
  return task.status === "running" && task.working.length === 0;
}

export type StatusTone = "amber" | "blue" | "green" | "violet" | "coral" | "neutral";

export interface StatusInfo {
  label: string;
  tone: StatusTone;
}

const PAUSE_WORDS: Record<string, string> = {
  limit: "usage limit",
  offline: "connection lost",
  error: "error",
  owner: "stopped by you",
};

export function statusInfo(status: TaskStatus, pausedReason?: string, yourTurn = false): StatusInfo {
  if (status === "running" && yourTurn) return { label: "Your turn", tone: "violet" };
  switch (status) {
    case "inbox":
      return { label: "Inbox", tone: "neutral" };
    case "ready":
      return { label: "Ready", tone: "blue" };
    case "running":
      return { label: "Working", tone: "amber" };
    case "paused":
      return {
        label: pausedReason ? `Paused · ${PAUSE_WORDS[pausedReason] ?? pausedReason}` : "Paused",
        tone: "coral",
      };
    case "review":
      return { label: "Your review", tone: "violet" };
    case "mr":
      return { label: "MR open", tone: "green" };
    case "done":
      return { label: "Done", tone: "green" };
  }
}

/** The one main action of a task by status. Review and MR tasks have none in 2a. */
export function primaryAction(status: TaskStatus): "start" | "stop" | "resume" | null {
  switch (status) {
    case "inbox":
    case "ready":
      return "start";
    case "running":
      return "stop";
    case "paused":
      return "resume";
    default:
      return null;
  }
}

// Agents --------------------------------------------------------------------

type OkAgent = Extract<AgentEntry, { status: "ok" }>;

const ROLE_RANK: Record<string, number> = { Lead: 0, Builder: 1 };

function okAgents(entries: readonly AgentEntry[]): OkAgent[] {
  return entries.filter((entry): entry is OkAgent => entry.status === "ok");
}

/** Agents that may work in the org (`where` names it or `anywhere`). Without an org, every agent. */
export function eligibleAgents(entries: readonly AgentEntry[], org: string | undefined): OkAgent[] {
  return okAgents(entries).filter((entry) => {
    if (org === undefined) return true;
    const where = entry.agent.frontmatter.where;
    return where.includes("anywhere") || where.includes(org);
  });
}

/**
 * The agent a task gets when the owner names none (DECISIONS: mentioned, else Lead, then Builder,
 * then others, org-scoped before root; a chat task without an org goes to the boss). The server
 * decides in the end; this is what the chip shows.
 */
export function defaultAgentId(
  entries: readonly AgentEntry[],
  org: string | undefined,
  kind: TaskKind,
): string | undefined {
  if (org === undefined && kind === "chat") {
    const boss = okAgents(entries).find((entry) => entry.isBoss);
    if (boss) return boss.agent.frontmatter.id;
  }
  const rank = (entry: OkAgent) => {
    const fm = entry.agent.frontmatter;
    return (fm.scope === org ? 0 : 10) + (ROLE_RANK[fm.role] ?? 5);
  };
  const [best] = eligibleAgents(entries, org).toSorted(
    (a, b) => rank(a) - rank(b) || a.agent.frontmatter.id.localeCompare(b.agent.frontmatter.id),
  );
  return best?.agent.frontmatter.id;
}

const AVATAR_TONES = ["bg-blue", "bg-green", "bg-coral", "bg-violet", "bg-amber"] as const;

/** A stable avatar color class for an agent id. */
export function avatarTone(id: string): (typeof AVATAR_TONES)[number] {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length] ?? "bg-blue";
}

/** The letter on an agent's avatar, as in the design: the first letter of the last word of its id. "globex-builder" gives B. */
export function initialOf(id: string): string {
  const last = id.split("-").findLast((word) => word !== "") ?? id;
  return (last[0] ?? "?").toUpperCase();
}
