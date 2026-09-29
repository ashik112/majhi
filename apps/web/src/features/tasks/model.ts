import {
  type AgentEntry,
  type OrgView,
  type ParsedTask,
  type ProjectView,
  type TaskKind,
  type TaskStatus,
  type TaskSummary,
  taskGroup,
} from "@majhi/shared";

// Task list -----------------------------------------------------------------

export type GroupId = ReturnType<typeof taskGroup>;

export const GROUP_LABEL: Record<GroupId, string> = {
  "needs-you": "Needs you",
  working: "Working",
  "up-next": "Up next",
  done: "Done",
};

const GROUP_ORDER: readonly GroupId[] = ["needs-you", "working", "up-next", "done"];

export interface TaskGroupView {
  id: GroupId;
  label: string;
  tasks: TaskSummary[];
}

/** A running task whose agents all finished their turn: it waits for the owner. */
export function isYourTurn(task: Pick<TaskSummary, "status" | "working">): boolean {
  return task.status === "running" && task.working.length === 0;
}

/** The list group of a task: its status group, except running tasks that wait for the owner. */
export function listGroup(task: TaskSummary): GroupId {
  return isYourTurn(task) ? "needs-you" : taskGroup(task.status);
}

/** Groups in the fixed order of SPEC 2, newest update first inside each. Empty groups are left out. */
export function groupTasks(tasks: readonly TaskSummary[]): TaskGroupView[] {
  return GROUP_ORDER.map((id) => ({
    id,
    label: GROUP_LABEL[id],
    tasks: tasks
      .filter((task) => listGroup(task) === id)
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  })).filter((group) => group.tasks.length > 0);
}

/** Task ids in the order they appear on screen, so `j` and `k` skip the rows of a collapsed group. */
export function visibleTaskIds(groups: readonly TaskGroupView[], doneOpen: boolean): string[] {
  return groups.filter((group) => group.id !== "done" || doneOpen).flatMap((g) => g.tasks.map((t) => t.id));
}

/** The id after moving `delta` rows from `current`, clamped to the list. Without a current row it starts at an end. */
export function moveCursor(
  ids: readonly string[],
  current: string | undefined,
  delta: number,
): string | undefined {
  if (ids.length === 0) return undefined;
  const at = current === undefined ? -1 : ids.indexOf(current);
  if (at === -1) return ids[delta > 0 ? 0 : ids.length - 1];
  return ids[Math.min(ids.length - 1, Math.max(0, at + delta))];
}

export type StatusTone = "amber" | "blue" | "green" | "violet" | "coral" | "neutral";

export interface StatusInfo {
  label: string;
  tone: StatusTone;
}

export function statusInfo(status: TaskStatus, pausedReason?: string, yourTurn = false): StatusInfo {
  if (status === "running" && yourTurn) return { label: "Your turn", tone: "violet" };
  switch (status) {
    case "inbox":
      return { label: "Not started", tone: "neutral" };
    case "ready":
      return { label: "Ready", tone: "blue" };
    case "running":
      return { label: "Working", tone: "amber" };
    case "paused":
      return { label: pausedReason ? `Paused, ${pausedReason}` : "Paused", tone: "coral" };
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

export function initialOf(id: string): string {
  return (id.replace(/[^a-z0-9]/gi, "")[0] ?? "?").toUpperCase();
}

// Org colors ----------------------------------------------------------------

export function orgColor(orgs: readonly OrgView[], org: string | undefined): string | undefined {
  return org === undefined ? undefined : orgs.find((o) => o.id === org)?.color;
}

// Task box chips ------------------------------------------------------------

export type ChipTone = "neutral" | "warn" | "blue";

export interface Chip {
  id: string;
  label: string;
  tone: ChipTone;
  /** Chips the owner can click to change. */
  action?: "agent" | "kind";
  title?: string;
}

export interface ChipInput {
  /** Null while the text is empty or the parser is not available. */
  parsed: ParsedTask | null;
  projects: readonly ProjectView[];
  /** The agent the owner picked, if any. Wins over a mention and the default. */
  agentOverride?: string | undefined;
  /** The agent the server would pick, when nothing is mentioned or picked. */
  defaultAgent?: string | undefined;
  kindOverride?: TaskKind | undefined;
}

/** The kind the task will be created with: the owner's switch, else what the parser inferred. */
export function effectiveKind(parsed: ParsedTask | null, override: TaskKind | undefined): TaskKind {
  return override ?? parsed?.kind ?? "code";
}

/** Chips for the text so far: repos with base, working branch, agent, kind, links and warnings. */
export function buildChips(input: ChipInput): Chip[] {
  const { parsed } = input;
  if (!parsed) return [];
  const chips: Chip[] = [];

  for (const repo of parsed.repos) {
    const project = input.projects.find((p) => p.id === repo.project);
    const base = parsed.base ?? project?.base ?? "default branch";
    chips.push({ id: `repo-${repo.project}`, label: `${repo.project}: from ${base}`, tone: "neutral" });
  }
  if (parsed.repos.length === 0 && parsed.base) {
    chips.push({ id: "base", label: `from ${parsed.base}`, tone: "neutral" });
  }
  if (parsed.branch) chips.push({ id: "branch", label: `branch ${parsed.branch}`, tone: "neutral" });

  const agent = input.agentOverride ?? parsed.mentions[0] ?? input.defaultAgent;
  if (agent) {
    const mentioned = input.agentOverride === undefined && parsed.mentions.length > 0;
    chips.push({
      id: "agent",
      label: `@${agent}`,
      tone: "blue",
      action: "agent",
      title: mentioned ? "Named in the text. Click to pick another agent" : "Click to change the agent",
    });
  }

  const kind = effectiveKind(parsed, input.kindOverride);
  chips.push({
    id: "kind",
    label: kind,
    tone: "neutral",
    action: "kind",
    title:
      kind === "chat"
        ? "Chat: talk with the agent, no worktree. Click for code"
        : "Code: work in worktrees. Click for chat",
  });

  if (parsed.links.length > 0) {
    chips.push({
      id: "links",
      label: `${parsed.links.length} ${parsed.links.length === 1 ? "link" : "links"}`,
      tone: "neutral",
      title: parsed.links.join("\n"),
    });
  }
  for (const [i, warning] of parsed.warnings.entries()) {
    chips.push({ id: `warn-${i}`, label: warning, tone: "warn" });
  }
  return chips;
}

/** What a key press in the task box does. Enter adds a line; Cmd or Ctrl with Enter starts the task. */
export function taskBoxKey(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
}): "start" | "default" {
  if (event.isComposing) return "default";
  return event.key === "Enter" && (event.metaKey || event.ctrlKey) ? "start" : "default";
}

/** The `tasks.create` overrides: only what the owner changed, so the server's own choice stays. */
export function createOverrides(
  parsed: ParsedTask | null,
  kindOverride: TaskKind | undefined,
  agentOverride: string | undefined,
): { kind?: TaskKind; agent?: string } {
  const out: { kind?: TaskKind; agent?: string } = {};
  if (kindOverride !== undefined && kindOverride !== parsed?.kind) out.kind = kindOverride;
  if (agentOverride !== undefined) out.agent = agentOverride;
  return out;
}

/** "api" or "api + web" for a task row; "no repo" when there is none. */
export function repoLabel(repos: readonly { project: string }[]): string {
  return repos.length === 0 ? "no repo" : repos.map((r) => r.project).join(" + ");
}
