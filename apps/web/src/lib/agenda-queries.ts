import type { AgendaToday, DeadlineUpsertInput } from "@majhi/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/**
 * `agenda.today`: everything Today shows in one request (brief, agenda, Watch, Plan). The business,
 * findings, captain, autonomy, tasks and agenda topics refetch it; a minute poll keeps "waiting 3 h" honest.
 */
export function useAgendaToday(org: string | undefined) {
  return useQuery<AgendaToday, ApiRequestError>({
    queryKey: [...queryKeys.agenda, org ?? ""],
    queryFn: () => cmd("agenda.today", org === undefined ? {} : { org }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

function useAgendaCommand<I, R>(run: (input: I) => Promise<R>) {
  const client = useQueryClient();
  return useMutation<R, ApiRequestError, I>({
    mutationFn: run,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.agenda }),
  });
}

export function useMakeBrief() {
  return useAgendaCommand<void, AgendaToday>(() =>
    cmd("agenda.brief", { force: true }, { reason: "Owner asked for today's brief" }),
  );
}

export function useDismissBrief() {
  return useAgendaCommand<string, { day: string }>((day) =>
    cmd("agenda.dismissBrief", { day }, { reason: "Owner dismissed the brief" }),
  );
}

export function useSetReviewBudget() {
  return useAgendaCommand<number, AgendaToday>((budgetMinutes) =>
    cmd("agenda.configure", { budgetMinutes }, { reason: "Owner set the daily review time" }),
  );
}

/** Dismisses a finding from Today. */
export function useDismissFinding() {
  return useAgendaCommand<number, unknown>((id) =>
    cmd("findings.dismiss", { id, reason: "Dismissed from Today" }, { reason: "Owner dismissed a finding" }),
  );
}

/** Marks a deadline done. It reads the deadline first so nothing else on it changes. */
export function useCloseDeadline() {
  return useAgendaCommand<number, unknown>(async (id) => {
    const { deadlines } = await cmd("deadlines.list", { status: "all", limit: 2000 });
    const d = deadlines.find((x) => x.id === id);
    if (d === undefined) return undefined;
    const input: DeadlineUpsertInput = {
      id: d.id,
      ...(d.org === undefined ? {} : { org: d.org }),
      kind: d.kind,
      title: d.title,
      due: d.due,
      tz: d.tz,
      source: d.source,
      notes: d.notes,
      leadDays: d.leadDays,
      ...(d.goal === undefined ? {} : { goal: d.goal }),
      ...(d.finding === undefined ? {} : { finding: d.finding }),
      ...(d.contact === undefined ? {} : { contact: d.contact }),
      status: "done",
    };
    return cmd("deadlines.upsert", input, { reason: "Owner closed a deadline from Today" });
  });
}
