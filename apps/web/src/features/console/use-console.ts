import {
  type Conversation,
  type OrgView,
  type OwnerDecision,
  PRIVATE,
  type TaskSummary,
} from "@majhi/shared";
import { useMemo } from "react";
import { workspaceOf } from "@/features/decisions/model";
import { useCaptainStatus } from "@/lib/captain-queries";
import { useConversations } from "@/lib/conversation-queries";
import { useDecisions } from "@/lib/decision-queries";
import { type DoingFact, useHomeFacts } from "@/lib/home-queries";
import { useNotices } from "@/lib/notice-queries";
import { useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";
import { useAllTasks } from "@/lib/task-queries";
import { useHiddenIds } from "./actions";
import {
  askingTasks,
  buildChips,
  buildRails,
  buildWork,
  type ChatChip,
  type Rails,
  type WorkspaceGroup,
  workspaceHues,
} from "./model";
import { buildNeeds, type Needs } from "./needs-model";

export interface ConsoleData {
  loading: boolean;
  orgs: readonly OrgView[] | undefined;
  org: string | undefined;
  hues: ReadonlyMap<string, number>;
  tasks: ReadonlyMap<string, TaskSummary>;
  needs: Needs;
  work: WorkspaceGroup[];
  rails: Rails;
  /** What each agent does now, for a task whose agent has not set Now. */
  doing: ReadonlyMap<string, DoingFact>;
  /** Decisions waiting per workspace, before the workspace filter. */
  waitingByOrg: ReadonlyMap<string, number>;
  /** The question of the card that waits on a task, for the line under a case in Work. */
  askOf: ReadonlyMap<string, string>;
  counts: { incidents: number; needYou: number; working: number; queued: number };
  captainAgent: string | undefined;
  conversations: Conversation[] | undefined;
  chips: (selectedTask: TaskSummary | undefined) => ChatChip[];
}

/** A decision shows under the workspace filter when it belongs to it, or to none (a sign-in, a budget). */
function inFilter(d: OwnerDecision, org: string | undefined): boolean {
  const ws = workspaceOf(d);
  return org === undefined || ws === undefined || ws === org;
}

/** Everything the console draws, from the queries the app already keeps current. */
export function useConsoleData(now: number): ConsoleData {
  const decisions = useDecisions();
  const taskList = useAllTasks();
  const orgs = useOrgs().data;
  const notices = useNotices().data;
  const conversations = useConversations().data;
  const doingFacts = useHomeFacts().doing;
  const captainAgent = useCaptainStatus().data?.captain;
  const { org } = useOrgFilter();
  const hidden = useHiddenIds();

  const tasks = useMemo(() => new Map((taskList.data ?? []).map((t) => [t.id, t])), [taskList.data]);
  const hues = useMemo(() => workspaceHues(orgs), [orgs]);
  const all = decisions.data?.decisions;

  const waitingByOrg = useMemo(() => {
    const by = new Map<string, number>();
    for (const d of all ?? []) {
      if (hidden.has(d.id)) continue;
      const ws = workspaceOf(d);
      if (ws !== undefined) by.set(ws, (by.get(ws) ?? 0) + 1);
    }
    return by;
  }, [all, hidden]);

  const needs = useMemo(
    () =>
      buildNeeds({
        decisions: (all ?? []).filter((d) => !hidden.has(d.id) && inFilter(d, org)),
        notices: (notices?.notices ?? []).filter(
          (n) =>
            !hidden.has(`notice:${n.id}`) &&
            !hidden.has(n.id) &&
            (org === undefined || (n.org ?? PRIVATE) === org),
        ),
        tasks,
        orgs,
      }),
    [all, hidden, org, notices, tasks, orgs],
  );

  const asking = useMemo(() => askingTasks(all ?? []), [all]);
  const askOf = useMemo(() => {
    const by = new Map<string, string>();
    for (const d of all ?? []) {
      if (d.task !== undefined && !hidden.has(d.id) && !by.has(d.task)) by.set(d.task, d.title);
    }
    return by;
  }, [all, hidden]);
  const orgOrder = useMemo(() => [PRIVATE, ...(orgs ?? []).map((o) => o.id)], [orgs]);
  const work = useMemo(
    () => buildWork(taskList.data ?? [], asking, org, orgOrder),
    [taskList.data, asking, org, orgOrder],
  );
  const rails = useMemo(() => buildRails(taskList.data ?? [], org, now), [taskList.data, org, now]);

  const doing = doingFacts;

  const counts = useMemo(
    () => ({
      incidents: needs.incident.length,
      needYou: needs.incident.length + needs.decide.length + needs.review.length,
      working: work.reduce((n, w) => n + w.counts.working, 0),
      queued: rails.queued.length,
    }),
    [needs, work, rails],
  );

  const chips = useMemo(
    () => (selectedTask: TaskSummary | undefined) =>
      buildChips({
        conversations: conversations ?? [],
        captainAgent,
        selectedTask:
          selectedTask === undefined
            ? undefined
            : { id: selectedTask.id, title: selectedTask.name ?? selectedTask.title, org: selectedTask.org },
        org,
      }),
    [conversations, captainAgent, org],
  );

  return {
    loading: decisions.data === undefined || taskList.data === undefined,
    orgs,
    org,
    hues,
    tasks,
    needs,
    work,
    rails,
    doing,
    waitingByOrg,
    askOf,
    counts,
    captainAgent,
    conversations,
    chips,
  };
}
