import {
  type Conversation,
  type OrgView,
  PRIVATE,
  PRIVATE_COLOR,
  PRIVATE_KEY,
  PRIVATE_NAME,
} from "@majhi/shared";
import { badgeLetters } from "@/lib/format";

/** One workspace's conversations under its mark, as the dock lists them. */
export interface DockGroup {
  org: string;
  name: string;
  letters: string;
  color: string | undefined;
  unread: number;
  rows: Conversation[];
}

/**
 * Groups the list by workspace. The list comes newest message first, so groups and the rows in them
 * keep that order: the workspace with the newest message is on top. Tasks without a workspace are Private.
 */
export function groupByWorkspace(
  list: readonly Conversation[],
  orgs: readonly OrgView[] | undefined,
): DockGroup[] {
  const byId = new Map((orgs ?? []).map((o) => [o.id, o]));
  const groups = new Map<string, DockGroup>();
  for (const row of list) {
    const id = row.org ?? PRIVATE;
    let group = groups.get(id);
    if (group === undefined) {
      const org = byId.get(id);
      group = {
        org: id,
        name: org?.name ?? (id === PRIVATE ? PRIVATE_NAME : id),
        letters: badgeLetters(org?.key ?? (id === PRIVATE ? PRIVATE_KEY : id)),
        color: org?.color ?? (id === PRIVATE ? PRIVATE_COLOR : undefined),
        unread: 0,
        rows: [],
      };
      groups.set(id, group);
    }
    group.rows.push(row);
    group.unread += row.unread;
  }
  return [...groups.values()];
}

/** The badge text: the count, or 99+ past that. */
export function badgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** A row's name: a captain thread is the workspace's captain, a task is its title. */
export function rowTitle(row: Conversation, workspace: string): string {
  return row.kind === "captain" ? `Captain in ${workspace}` : row.title;
}
