import {
  type Conversation,
  DEFAULT_CHAT_TITLES,
  type OrgView,
  PRIVATE,
  PRIVATE_COLOR,
  PRIVATE_KEY,
  PRIVATE_NAME,
} from "@majhi/shared";
import type { ChatFilter, KindFilter } from "@/lib/chat-filter";
import { badgeLetters } from "@/lib/format";

/** The name a chat shows: its title, or "New chat" until the first message names it. */
export function chatTitle(chat: { title: string }): string {
  return DEFAULT_CHAT_TITLES.includes(chat.title) ? "New chat" : chat.title;
}

/** A workspace as a tab and a badge shows it. */
export interface Workspace {
  id: string;
  name: string;
  letters: string;
  color: string | undefined;
}

export const KIND_LABEL: Record<Conversation["kind"], string> = {
  client: "Client",
  task: "Task",
  agent: "Agent",
  captain: "Captain",
};

/** Private first, then each workspace. */
export function workspaces(orgs: readonly OrgView[] | undefined): Workspace[] {
  return [
    { id: PRIVATE, name: PRIVATE_NAME, letters: badgeLetters(PRIVATE_KEY), color: PRIVATE_COLOR },
    ...(orgs ?? [])
      .filter((o) => o.id !== PRIVATE)
      .map((o) => ({ id: o.id, name: o.name, letters: badgeLetters(o.key), color: o.color })),
  ];
}

/** The workspace a conversation belongs to; one without a workspace is Private. */
export function workspaceOf(row: Conversation, all: readonly Workspace[]): Workspace {
  const id = row.org ?? PRIVATE;
  return all.find((w) => w.id === id) ?? { id, name: id, letters: badgeLetters(id), color: undefined };
}

/** A row's name: a captain thread is the workspace's captain, an untitled agent chat is a new chat. */
export function rowTitle(row: Conversation, workspace: string): string {
  if (row.kind === "captain") return `Captain in ${workspace}`;
  return row.kind === "agent" ? chatTitle(row) : row.title;
}

/** Chats are client rooms and the owner's own chats (the Captain, agents). Task rooms and captain threads have their own pages. */
export function isChat(row: Pick<Conversation, "kind">): boolean {
  return row.kind === "client" || row.kind === "agent";
}

function kindMatches(row: Conversation, kind: KindFilter): boolean {
  return isChat(row) && (kind === "all" || row.kind === kind);
}

/** What the filter and the search keep, in the list's order (newest first). */
export function visibleConversations(
  list: readonly Conversation[],
  filter: ChatFilter,
  query: string,
  all: readonly Workspace[],
  /** Conversations whose messages hold the query (the server read their history). */
  inHistory: ReadonlySet<string> = new Set(),
): Conversation[] {
  const q = query.trim().toLowerCase();
  return list.filter((row) => {
    if ((row.archived === true) !== filter.archived) return false;
    if (filter.tab !== "all" && (row.org ?? PRIVATE) !== filter.tab) return false;
    if (!kindMatches(row, filter.kind)) return false;
    if (q === "") return true;
    const title = rowTitle(row, workspaceOf(row, all).name);
    return title.toLowerCase().includes(q) || row.lastLine.toLowerCase().includes(q) || inHistory.has(row.id);
  });
}

/** Unread agent messages per workspace tab (`all` is the total). Archived conversations do not count. */
export function unreadByTab(list: readonly Conversation[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of list) {
    if (row.archived === true || !isChat(row)) continue;
    const id = row.org ?? PRIVATE;
    out.set(id, (out.get(id) ?? 0) + row.unread);
    out.set("all", (out.get("all") ?? 0) + row.unread);
  }
  return out;
}

export function badgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}
