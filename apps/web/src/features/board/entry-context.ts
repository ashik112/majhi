import type { TaskSummary } from "@majhi/shared";
import { useMemo } from "react";
import { useHeldOption } from "../decisions/use-send-decision";
import type { OrgTag } from "../tasks-ui/project-names";
import type { LineContext, LiveState } from "./entry-text";
import {
  type ActionSpec,
  actionsOf,
  type Entry,
  type Relation,
  type RowEntry,
  type SectionId,
  type TreeInfo,
} from "./home-model";

/** What every row of the board shares: the focus, the selection, the clock, and the three callbacks. */
export interface RowHandlers {
  onFocus: (key: string) => void;
  onAct: (key: string, index: number) => void;
  onOpen: (key: string) => void;
  /** Open a task by its id: a nested subtask, a task another one waits on. */
  onOpenTask: (id: string) => void;
  onMore: (section: SectionId) => void;
  /** Fold or unfold the subtasks of a task in the tree. */
  onFold: (task: string) => void;
}

/** What a card or a tree row reads besides its own entry. Built once per screen. */
export interface EntryContext {
  now: number;
  line: LineContext;
  live: ReadonlyMap<string, LiveState>;
  relations: ReadonlyMap<string, Relation>;
  tasks: ReadonlyMap<string, TaskSummary>;
  /** The names of the parts of the system each task touches. */
  areas: ReadonlyMap<string, readonly string[]>;
  orgLabel: (entry: Entry) => OrgTag | undefined;
  /** Set in the tree: where each row stands in it. */
  treeInfo: ReadonlyMap<string, TreeInfo> | undefined;
  handlers: RowHandlers;
}

export function rowDomId(key: string): string {
  return `home-row-${key}`;
}

/** The task of a row, when it has one. A decision of the workspace has none. */
export function taskOfEntry(
  entry: RowEntry,
  tasks: ReadonlyMap<string, TaskSummary>,
): TaskSummary | undefined {
  switch (entry.type) {
    case "needs":
      return entry.item.decision.task === undefined ? undefined : tasks.get(entry.item.decision.task);
    case "captain":
      return entry.item.task === undefined ? undefined : tasks.get(entry.item.task);
    default:
      return entry.item.task;
  }
}

/**
 * The buttons of a row and whether one of them is sending. A decision's main action cannot succeed
 * for some reasons, and the list says which; the others are the same for every kind.
 */
export function useEntryActions(entry: RowEntry): { actions: ActionSpec[]; busy: boolean } {
  const decision = entry.type === "needs" ? entry.item.decision : undefined;
  const held = useHeldOption(decision?.id ?? "");
  const blocked = useMemo(
    () =>
      decision?.blocked === undefined
        ? undefined
        : Object.fromEntries(decision.options.map((o) => [o.id, decision.blocked ?? ""])),
    [decision],
  );
  return { actions: actionsOf(entry, () => blocked), busy: decision !== undefined && held !== undefined };
}
