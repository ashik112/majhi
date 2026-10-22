import {
  BOSS_CHAT_BRIEF,
  CAPTAIN_CHAT_TITLE,
  CHAT_BRIEF,
  DEFAULT_CHAT_TITLES,
  isAutonomyChat,
  isOwnerChat,
  SCREEN_MAP,
  type Task,
  WRITING_IN_THE_ROOM,
} from "@majhi/shared";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import { UserError } from "../errors.ts";
import type { Store } from "../store/index.ts";
import type { TaskService } from "../tasks/service.ts";
import { CAPTAIN_TEXT } from "./captain-text.ts";

export { BOSS_CHAT_BRIEF };

/**
 * True for any chat the owner has with an agent (the Chats page, Cmd J). Named for the captain chat it
 * began as: the run, review and memory code treats every such chat as an ongoing conversation.
 */
export const isBossChat = isOwnerChat;

/**
 * Added in front of a majhi-admin agent's first prompt in a session: the captain's text (the job and the limits),
 * then the facts it reads from: how to write in the room and the map of majhi's screens. The turn's own facts
 * (the level, Autonomous, the owner's intent, the wiki overview) come in the block each turn starts with.
 */
export const ADMIN_PREAMBLE = [
  CAPTAIN_TEXT,
  "",
  WRITING_IN_THE_ROOM,
  "",
  "majhi's screens (when you tell the owner where to do something, name only these pages and settings, with their path):",
  SCREEN_MAP,
].join("\n");

export interface BossChatDeps {
  config: ConfigService;
  store: Store;
  tasks: TaskService;
  agents: AgentStore;
  /** Tells every open tab that a conversation's row changed. */
  conversationChanged?: (id: string) => void;
}

/** A new chat with an agent. An untitled one that was never written in is reused, so New chat does not pile up empty chats. */
export async function openChat({ config, store, tasks, agents }: BossChatDeps, agent: string): Promise<Task> {
  const sections = await config.sections();
  const found = await agents.get(agent);
  if (found === undefined || !found.ok)
    throw new UserError(`Agent "${agent}" does not exist or is invalid.`, 404);
  const { scope } = found.agent.frontmatter;
  const org = scope === "root" ? undefined : scope;
  if (org !== undefined && sections.orgs[org] === undefined) {
    throw new UserError(`Org "${org}" does not exist.`, 409);
  }
  for (const summary of store.tasks.list(false)) {
    if (summary.chat !== true || summary.team[0] !== agent || summary.org !== org) continue;
    if (DEFAULT_CHAT_TITLES.includes(summary.title)) return tasks.get(summary.id);
  }
  return tasks.create({
    text: CHAT_BRIEF,
    kind: "chat",
    agent,
    org,
    attachments: [],
    start: false,
    provenance: { kind: "chat" },
    // A chat is a conversation, outside the gate.
    gate: "owner",
  });
}

/** The owner's current captain chat as `openBossChat` finds it, without making one. */
export function findBossChat(deps: Pick<BossChatDeps, "store" | "tasks">, boss: string): Task | undefined {
  for (const summary of deps.store.tasks.list(false)) {
    if (summary.chat !== true || summary.org !== undefined || summary.team[0] !== boss) continue;
    const task = deps.tasks.get(summary.id);
    if (!isAutonomyChat(task)) return task;
  }
  return undefined;
}

/**
 * The captain's current chat: the newest open one, or a new one. With `fresh`, the current one is
 * archived (done, still listed under its chats) and a new conversation starts. The autonomy chat
 * (PRV-74) is never it: autonomous mode talks to the captain there, not the owner's Cmd J.
 */
export async function openBossChat(deps: BossChatDeps, fresh = false): Promise<Task> {
  const { boss } = await deps.config.sections();
  if (boss === undefined) {
    throw new UserError("There is no captain yet. Create a root agent and make it the captain first.", 409);
  }
  const before = findBossChat(deps, boss)?.id;
  const current = await currentBossChat(deps, boss, fresh);
  const retired = await retireOlder(deps, boss, current.id);
  // The rows that changed: the new current chat, the one it replaced and each one archived.
  for (const id of new Set([current.id, ...(before === undefined ? [] : [before]), ...retired]))
    deps.conversationChanged?.(id);
  return current;
}

async function currentBossChat(deps: BossChatDeps, boss: string, fresh: boolean): Promise<Task> {
  // Newest first.
  for (const summary of deps.store.tasks.list(false)) {
    if (summary.chat !== true || summary.org !== undefined || summary.team[0] !== boss) continue;
    const task = deps.tasks.get(summary.id);
    if (isAutonomyChat(task)) continue;
    // A new chat with nothing said in the current one reuses it; otherwise the current one is archived below.
    const said = ["owner", "agent"].some(
      (type) => deps.store.room.ofType(task.id, type as "owner" | "agent").length > 0,
    );
    if (!fresh || !said) return titled(deps, task);
    // The owner asked for a new conversation. A chat has no repo of its own, so nothing stays behind.
    await deps.tasks.close(task.id, { by: "owner", whenUnshipped: "keep" });
    break;
  }
  return titled(deps, await openChat(deps, boss));
}

/** Only one root captain chat stays open: the others are closed and archived, still listed with their history. */
async function retireOlder(deps: BossChatDeps, boss: string, keep: string): Promise<string[]> {
  const retired: string[] = [];
  for (const summary of deps.store.tasks.list(false)) {
    if (summary.id === keep || summary.chat !== true || summary.org !== undefined || summary.team[0] !== boss)
      continue;
    const task = deps.tasks.get(summary.id);
    if (isAutonomyChat(task)) continue;
    await deps.tasks.close(task.id, { by: "owner", whenUnshipped: "keep" });
    deps.store.conversations.archive(task.id, true);
    retired.push(task.id);
  }
  return retired;
}

/** The captain chat is called "Captain" whatever was first said in it. */
function titled(deps: BossChatDeps, task: Task): Task {
  if (task.title === CAPTAIN_CHAT_TITLE) return task;
  deps.store.tasks.setText(task.id, CAPTAIN_CHAT_TITLE, task.brief, new Date().toISOString());
  return deps.tasks.get(task.id);
}
