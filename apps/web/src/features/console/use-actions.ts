import {
  batchPlan,
  type DecisionLink,
  type OwnerDecision,
  PAGE_PATH,
  type TaskSummary,
  taskLabel,
} from "@majhi/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useToast } from "@/components/ui/toast";
import { actionOf, openLabel } from "@/features/decisions/model";
import { cmd } from "@/lib/api";
import { useAfterBatch, useAnswerDecision } from "@/lib/decision-queries";
import { useFeedLost } from "@/lib/feed-status";
import { useOrgFilter } from "@/lib/org-filter";
import { queryKeys } from "@/lib/queries";
import { hold, holdOnServer, LATER_MS, later, say, UNDO_MS } from "./actions";
import { blockersOf } from "./model";
import type { NeedsRow } from "./needs-model";

/** What an answer's toast says: the button and what it answered. */
function line(label: string, what: string): string {
  return `${label}: ${what}`;
}

/** Everything the owner can do from the console: answer, answer a group, put off, open, start, stop. */
export function useConsoleActions(openChat: (id: string) => void) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const answer = useAnswerDecision();
  const afterBatch = useAfterBatch();
  const lost = useFeedLost();
  const toast = useToast();
  const filter = useOrgFilter();

  const refresh = useCallback(() => {
    void client.invalidateQueries({ queryKey: queryKeys.decisions });
    void client.invalidateQueries({ queryKey: queryKeys.notices });
    void client.invalidateQueries({ queryKey: queryKeys.tasks });
  }, [client]);

  const failed = useCallback(
    (title: string) => (message: string) => toast(title, { detail: message, tone: "error" }),
    [toast],
  );

  /** One decision, one option. A question is held by the server; everything else is held here. */
  const answerOne = useCallback(
    (decision: OwnerDecision, optionId: string, what: string, text?: string) => {
      if (lost) return say("Offline. The answer waits until majhi is back.");
      const option = decision.options.find((o) => o.id === optionId);
      if (option === undefined) return;
      const toastLine = line(option.label, what);
      const failure = failed(`Could not ${option.label.toLowerCase()}`);
      if (decision.kind === "question" && option.text !== true && text === undefined) {
        holdOnServer({
          text: toastLine,
          hidden: [decision.id],
          key: decision.id,
          start: () =>
            cmd(
              "decisions.answer",
              { id: decision.id, option: optionId, holdMs: UNDO_MS },
              { reason: "Owner answered a decision" },
            ),
          afterSend: refresh,
          onFail: failure,
        });
        return;
      }
      hold({
        text: toastLine,
        hidden: [decision.id],
        send: () =>
          answer.mutateAsync({ id: decision.id, option: optionId, ...(text === undefined ? {} : { text }) }),
        afterSend: refresh,
        onFail: failure,
      });
    },
    [lost, answer, refresh, failed],
  );

  /** Many decisions at once with the "approve" or "leave" button each has, after the undo time. */
  const answerMany = useCallback(
    (decisions: readonly OwnerDecision[], intent: "approve" | "leave", text: string) => {
      if (lost) return say("Offline. The answer waits until majhi is back.");
      const plan = batchPlan(decisions, intent);
      if (plan.ids.length === 0) return say("None of these can be done in one go. Open them one by one.");
      hold({
        text,
        hidden: plan.ids,
        send: () =>
          cmd(
            "decisions.answerBatch",
            { batch: crypto.randomUUID(), intent, ids: plan.ids },
            { reason: "Owner answered decisions in a batch" },
          ).then(afterBatch),
        afterSend: refresh,
        onFail: failed("Could not answer them"),
      });
    },
    [lost, afterBatch, refresh, failed],
  );

  /** Removes what held these tasks back, then lets them go on. */
  const unblock = useCallback(
    (decisions: readonly OwnerDecision[], tasks: ReadonlyMap<string, TaskSummary>, text: string) => {
      if (lost) return say("Offline. The answer waits until majhi is back.");
      const ids = decisions.map((d) => d.id);
      hold({
        text,
        hidden: ids,
        send: async () => {
          for (const d of decisions) {
            const task = d.task === undefined ? undefined : tasks.get(d.task);
            if (task === undefined) continue;
            for (const target of blockersOf(task)) {
              await cmd(
                "tasks.unlink",
                { task: task.id, type: "depends-on", target },
                { reason: "Owner removed a link that held a task" },
              );
            }
          }
          const plan = batchPlan(decisions, "approve");
          if (plan.ids.length > 0) {
            const out = await cmd(
              "decisions.answerBatch",
              { batch: crypto.randomUUID(), intent: "approve", ids: plan.ids },
              { reason: "Owner resumed tasks they unblocked" },
            );
            await afterBatch(out);
          }
        },
        afterSend: refresh,
        onFail: failed("Could not unblock them"),
      });
    },
    [lost, afterBatch, refresh, failed],
  );

  /** A held task: removes what it waits on, then resumes it. A task held for another reason opens instead. */
  const unblockTask = useCallback(
    (task: TaskSummary, what: string) => {
      if (lost) return say("Offline. The answer waits until majhi is back.");
      if (blockersOf(task).length === 0) {
        void navigate({ to: "/t/$taskId", params: { taskId: task.id }, search: {} });
        return;
      }
      hold({
        text: `Unblocked: ${what}`,
        hidden: [],
        send: async () => {
          for (const target of blockersOf(task)) {
            await cmd(
              "tasks.unlink",
              { task: task.id, type: "depends-on", target },
              { reason: "Owner removed a link that held a task" },
            );
          }
          if (task.status === "paused") {
            await cmd("tasks.start", { id: task.id }, { reason: "Owner resumed a task they unblocked" });
          }
        },
        afterSend: refresh,
        onFail: failed("Could not unblock it"),
      });
    },
    [lost, navigate, refresh, failed],
  );

  const putOff = useCallback((rows: readonly NeedsRow[], what: string) => {
    const ids = rows.flatMap((r) => (r.decisions.length > 0 ? r.decisions.map((d) => d.id) : [r.id]));
    const until = Date.now() + LATER_MS;
    const at = new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    later(ids, `Later: back in Needs you at ${at} (${what})`, until);
  }, []);

  /** Opens what a link points at: a task page, a chat in the console, or a Settings page. */
  const open = useCallback(
    (link: DecisionLink) => {
      const action = actionOf(link);
      if (action.kind === "task") {
        void navigate({
          to: "/t/$taskId",
          params: { taskId: action.id },
          search: action.item === undefined ? {} : { item: action.item },
        });
      } else if (action.kind === "chat") openChat(action.id);
      else if (action.kind === "page") {
        if (action.to === PAGE_PATH.captain) openChat("captain");
        else void navigate({ to: action.to, search: { ...action.search } });
      }
    },
    [navigate, openChat],
  );

  /** Done with the captain's done item: it stops being new and leaves Needs you. */
  const read = useCallback(
    (row: NeedsRow) => {
      const notice = row.notice;
      if (notice === undefined) return;
      void cmd("notices.markRead", { id: notice.id }, { reason: "Owner read a notice" }).then(() =>
        client.invalidateQueries({ queryKey: queryKeys.notices }),
      );
    },
    [client],
  );

  /** Open where the captain's done item lives. It stays until the owner says Done. */
  const openNotice = useCallback(
    (row: NeedsRow) => {
      const notice = row.notice;
      if (notice === undefined) return;
      if (notice.kind === "brief") {
        // The brief is a line in the workspace's own captain conversation: open it there.
        if (filter.org !== undefined && notice.org !== undefined && filter.org !== notice.org) {
          filter.setOrg(notice.org);
        }
        openChat("captain");
      } else if (notice.link.kind === "page") {
        void navigate({ to: PAGE_PATH[notice.link.page] });
      } else open(notice.link);
    },
    [filter, navigate, open, openChat],
  );

  const start = useCallback(
    (task: TaskSummary, now: boolean) => {
      if (lost) return say("Offline. It starts when majhi is back.");
      const label = taskLabel(task);
      void cmd(
        "tasks.start",
        { id: task.id, ...(now ? { now: true } : {}) },
        { reason: "Owner started a task" },
      ).then(
        () => {
          toast(`Started: ${label}`);
          refresh();
        },
        (error: unknown) =>
          toast("Could not start it", {
            detail: error instanceof Error ? error.message : String(error),
            tone: "error",
          }),
      );
    },
    [lost, toast, refresh],
  );

  const stop = useCallback(
    (task: TaskSummary) => {
      if (lost) return say("Offline. The stop waits until majhi is back.");
      const label = taskLabel(task);
      void cmd("tasks.stop", { id: task.id }, { reason: "Owner stopped a task" }).then(
        () => {
          toast(`Stopped: ${label}`);
          refresh();
        },
        (error: unknown) =>
          toast("Could not stop it", {
            detail: error instanceof Error ? error.message : String(error),
            tone: "error",
          }),
      );
    },
    [lost, toast, refresh],
  );

  return {
    answerOne,
    answerMany,
    unblock,
    unblockTask,
    putOff,
    open,
    read,
    openNotice,
    start,
    stop,
    openLabel,
  };
}
