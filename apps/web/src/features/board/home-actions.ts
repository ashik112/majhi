import { useCallback, useRef } from "react";
import { useRunAttention } from "@/components/shell/banner";
import { useToast } from "@/components/ui/toast";
import { actionOf } from "@/features/decisions/model";
import { useSendDecision } from "@/features/decisions/use-send-decision";
import { cmd } from "@/lib/api";
import { useCaptainUndo } from "@/lib/captain-queries";
import { describeError } from "@/lib/errors";
import type { ActionSpec, RowEntry } from "./home-model";

/** What an agent is told when the owner presses "Fix with agent" on a failed check. */
const FIX_CI_TEXT =
  "The checks of your merge request failed. Open the failing checks, fix what broke and push.";

/**
 * Runs the numbered actions of a Home row. One stable function: the rows are memoised, and a fresh
 * callback each render would draw all of them again. The events of the feed bring the new state back,
 * so nothing here reads a list again.
 */
export function useHomeActions(): {
  act: (entry: RowEntry, spec: ActionSpec) => void;
  open: (entry: RowEntry) => void;
} {
  const run = useRunAttention();
  const { send } = useSendDecision();
  const undo = useCaptainUndo();
  const toast = useToast();
  const latest = useRef({ run, send, undo, toast });
  latest.current = { run, send, undo, toast };

  const act = useCallback((entry: RowEntry, spec: ActionSpec) => {
    const { run: go, send: answer, undo: revert, toast: say } = latest.current;
    const fail = (title: string) => (error: unknown) =>
      say(title, { detail: describeError(error), tone: "error" });
    switch (spec.kind) {
      case "go":
        go(spec.action);
        return;
      case "answer":
        if (entry.type === "needs") answer(entry.item.decision, spec.option);
        return;
      case "start":
        cmd("tasks.start", { id: spec.task }).then(
          (task) => say(`Started ${task.id}`),
          fail(`Could not start ${spec.task}`),
        );
        return;
      case "stop":
        cmd("tasks.stop", { id: spec.task }).then(
          (task) => say(`Stopped ${task.id}`),
          fail(`Could not stop ${spec.task}`),
        );
        return;
      case "merge":
        cmd("tasks.mergeMrs", { id: spec.task }).then(
          (result) =>
            say(
              result.stoppedAt === undefined
                ? `Merged ${spec.task}`
                : `Stopped at ${result.stoppedAt.project}`,
              result.stoppedAt === undefined ? {} : { detail: result.stoppedAt.reason, tone: "error" },
            ),
          fail(`Could not merge ${spec.task}`),
        );
        return;
      case "recheck":
        cmd(
          "handoff.check",
          { task: spec.task, force: true },
          { reason: "Owner asked for the check again" },
        ).then(() => say(`Checking ${spec.task} again`), fail(`Could not check ${spec.task}`));
        return;
      case "wait":
        return;
      case "fix-ci":
        cmd("room.send", { task: spec.task, text: FIX_CI_TEXT, attachments: [], mode: "queue" }).then(
          () => say(`Asked the agent to fix ${spec.task}`),
          fail(`Could not message ${spec.task}`),
        );
        return;
      case "undo":
        revert.mutate(
          { id: spec.id },
          {
            onSuccess: (done) => say("Undone", { detail: done.detail }),
            onError: fail("Could not undo it"),
          },
        );
        return;
    }
  }, []);

  /** Enter and a click on the title: the task, the decision's own place, or the captain. */
  const open = useCallback((entry: RowEntry) => {
    const { run: go } = latest.current;
    switch (entry.type) {
      case "needs":
        go(actionOf(entry.item.decision.link));
        return;
      case "captain":
        go(
          entry.item.task === undefined
            ? { kind: "page", to: "/captain" }
            : { kind: "task", id: entry.item.task },
        );
        return;
      case "running":
      case "background":
      case "shipping":
      case "next":
      case "triage":
        go({ kind: "task", id: entry.item.task.id });
        return;
      case "done":
        go({ kind: "task", id: entry.item.task.id });
        return;
    }
  }, []);

  return { act, open };
}
