import type { CaptainRunnableChore } from "@majhi/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { type ApiRequestError, cmd } from "@/lib/api";
import { useCaptainStatus } from "@/lib/captain-queries";
import { describeError } from "@/lib/errors";
import { queryKeys } from "@/lib/queries";

/**
 * "Review now" (SPEC 5.18, Memory): the owner runs the memory or cleanup chore of a workspace by hand.
 * The run goes on in the background, so the state of the click lives outside any one button: the
 * Memory page and the Delegation sheet show the same progress and the same result line.
 */

type Phase = "starting" | "running" | "done";
interface Run {
  /** How many memories waited when it started. Zero for a chore that counts nothing. */
  before: number;
  phase: Phase;
  startedAt: number;
  overCap: boolean;
}

const runs = new Map<string, Run>();
const listeners = new Set<() => void>();
let version = 0;
const keyOf = (org: string, chore: CaptainRunnableChore) => `${org}:${chore}`;

function put(key: string, run: Run | undefined): void {
  if (run === undefined) runs.delete(key);
  else runs.set(key, run);
  version += 1;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** After this long without a sign of a run, a click that started nothing visible counts as finished. */
const QUICK_MS = 3_000;

export interface ReviewNow {
  /** Starts the run. `waiting` is how many memories wait now, for the progress line. */
  start: (waiting: number) => void;
  busy: boolean;
  /** "Reviewing 41 memories...", the result line, or nothing. */
  line: string | undefined;
}

const NOUN: Record<CaptainRunnableChore, string> = { memory: "memories", cleanup: "tasks" };

/** Starts a run in any workspace: for the button of the selected one and for a menu of all. */
export function useStartReview() {
  const toast = useToast();
  const client = useQueryClient();
  const command = useMutation<
    { started: boolean; text: string; overCap: boolean },
    ApiRequestError,
    { org: string; chore: CaptainRunnableChore; before: number }
  >({
    mutationFn: ({ org, chore }) =>
      cmd(
        "captain.runChore",
        { org, chore },
        { reason: `Owner asked for ${chore === "memory" ? "a memory review" : "a cleanup"} now` },
      ),
    onSuccess: (result, { org, chore, before }) => {
      if (!result.started) {
        toast(result.text, { tone: "error" });
        return;
      }
      if (result.overCap) toast(result.text);
      put(keyOf(org, chore), { before, phase: "starting", startedAt: Date.now(), overCap: result.overCap });
      void client.invalidateQueries({ queryKey: queryKeys.captain });
    },
    onError: (error) => toast("Could not start it", { detail: describeError(error), tone: "error" }),
  });
  return {
    pending: command.isPending,
    start: (org: string, chore: CaptainRunnableChore, before: number) =>
      command.mutate({ org, chore, before }),
  };
}

/** The run of one chore in one workspace: its button state and its line. `waiting` is the count that still waits. */
export function useReviewNow(org: string, chore: CaptainRunnableChore, waiting: number): ReviewNow {
  const client = useQueryClient();
  const status = useCaptainStatus();
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  const key = keyOf(org, chore);
  const run = runs.get(key);
  const running =
    status.data?.orgs.find((o) => o.org === org)?.chores.find((c) => c.chore === chore)?.running === true;

  // The status says when the run began and when it ended.
  const seen = useRef(false);
  useEffect(() => {
    const current = runs.get(key);
    if (current === undefined || current.phase === "done") {
      seen.current = false;
      return;
    }
    if (running) {
      seen.current = true;
      if (current.phase !== "running") put(key, { ...current, phase: "running" });
      return;
    }
    if (seen.current || Date.now() - current.startedAt > QUICK_MS) {
      seen.current = false;
      put(key, { ...current, phase: "done" });
      void client.invalidateQueries({ queryKey: queryKeys.memory });
    }
  }, [running, key, client, run?.phase, status.dataUpdatedAt]);

  const command = useStartReview();

  const busy = command.pending || run?.phase === "starting" || run?.phase === "running";
  let line: string | undefined;
  if (run !== undefined && run.phase !== "done") {
    line =
      chore === "memory"
        ? `Reviewing ${Math.max(waiting, 1)} ${NOUN[chore]}...`
        : "Cleaning up finished tasks...";
  } else if (run !== undefined) {
    if (chore === "cleanup") line = "Cleanup finished. The captain's log lists what it did.";
    else {
      const handled = Math.max(run.before - waiting, 0);
      line =
        run.before === 0
          ? "Nothing was waiting."
          : handled === 0
            ? `Looked at ${run.before}. All of them need your judgment.`
            : waiting === 0
              ? `Done. All ${run.before} are handled.`
              : `Done. ${handled} handled, ${waiting} still wait for you.`;
    }
  }
  return {
    start: (before) => command.start(org, chore, before),
    busy,
    line,
  };
}

/** The button for one workspace's chore, with its line under it when `showLine`. */
export function ReviewNowButton({
  org,
  chore = "memory",
  waiting,
  label,
  size = "md",
  showLine = true,
}: {
  org: string;
  chore?: CaptainRunnableChore;
  waiting: number;
  label?: string;
  size?: "sm" | "md";
  showLine?: boolean;
}) {
  const run = useReviewNow(org, chore, waiting);
  const text = label ?? (chore === "memory" ? "Review now" : "Clean up now");
  return (
    <span className="flex min-w-0 flex-col items-end gap-1">
      <Button
        size={size}
        variant="secondary"
        disabled={run.busy || (chore === "memory" && waiting === 0)}
        title={
          chore === "memory" && waiting === 0
            ? "No memory waits for review."
            : "The captain looks at every waiting memory now"
        }
        onClick={() => run.start(waiting)}
      >
        {run.busy ? "Working..." : text}
      </Button>
      {showLine && run.line !== undefined && (
        <span role="status" className="max-w-[320px] text-right text-xs text-fg-muted text-pretty">
          {run.line}
        </span>
      )}
    </span>
  );
}
