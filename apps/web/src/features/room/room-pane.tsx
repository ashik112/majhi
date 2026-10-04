import type { RoomItem, Task } from "@majhi/shared";
import { useMutation } from "@tanstack/react-query";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { type ApiRequestError, cmd } from "@/lib/api";
import { Composer } from "./composer";
import { isBusy, type RoomAction, type RoomState } from "./model";
import type { OwnerContext } from "./owner-cards";
import { Timeline } from "./timeline";

/** The main column of a task: the messages and the composer. */
export function RoomPane({
  task,
  state,
  dispatch,
  loadOlder,
  loadAround,
  loadNewer,
  loadLatest,
  onShowChanges,
  focusItem,
  onFocused,
  foldSteps,
  initialDraft,
}: {
  /** Reads as a conversation: steps between messages fold into one line. */
  foldSteps?: boolean | undefined;
  task: Task;
  state: RoomState;
  dispatch: (action: RoomAction) => void;
  loadOlder: () => Promise<void>;
  /** Search matches: the page around an item, the next newer page, and the newest page again. */
  loadAround?: ((item: string) => Promise<boolean>) | undefined;
  loadNewer?: (() => Promise<void>) | undefined;
  loadLatest?: (() => Promise<void>) | undefined;
  /** Opens the Changes tab. */
  onShowChanges?: (() => void) | undefined;
  /** A search match to scroll to, and what to do once it was shown. */
  focusItem?: string | undefined;
  onFocused?: (() => void) | undefined;
  /** Text for the message box when the room opens; the box takes focus. */
  initialDraft?: string | undefined;
}) {
  const toast = useToast();
  // Text a card button puts in the composer; `n` changes on every click.
  const [draft, setDraft] = useState<{ text: string; n: number } | undefined>(
    initialDraft === undefined ? undefined : { text: initialDraft, n: 1 },
  );
  const compose = useCallback((text: string) => setDraft((d) => ({ text, n: (d?.n ?? 0) + 1 })), []);
  // Agents in the middle of a turn, each with its oldest queued message, as one string so the
  // cards redraw only when that changes, not on every tool call.
  const turningKey = state.agents
    .filter((a) => a.status === "working")
    .map((a) => {
      const queued = state.items.find(
        (i) => i.type === "owner" && i.queued && (i.to ?? task.team[0]) === a.agent,
      );
      return `${a.agent}=${queued?.id ?? ""}`;
    })
    .join("\n");
  const owner = useMemo<OwnerContext>(
    () => ({
      task,
      compose,
      showChanges: onShowChanges,
      turning: turningKey
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
          const at = line.indexOf("=");
          return { agent: line.slice(0, at), queuedItem: line.slice(at + 1) || undefined };
        }),
    }),
    [task, compose, onShowChanges, turningKey],
  );
  // A running task with no agent yet is still being set up (worktrees, session): Esc stops that too.
  const starting = task.status === "running" && state.agents.length === 0;
  const busy = isBusy(state.agents) || starting;
  // "Stopping..." from Esc or Stop until the agent is no longer busy, with a cap so it never sticks.
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!busy) setStopping(false);
  }, [busy]);
  useEffect(() => {
    if (!stopping) return;
    const timer = setTimeout(() => setStopping(false), 8000);
    return () => clearTimeout(timer);
  }, [stopping]);
  // Around a search match, going to the newest messages also scrolls the view to them.
  const [jumpSignal, setJumpSignal] = useState(0);
  const jumpToLatest = useCallback(() => {
    setJumpSignal((n) => n + 1);
    void loadLatest?.();
  }, [loadLatest]);

  const cancel = useMutation<{ cancelled: string[] }, ApiRequestError, void>({
    mutationFn: () => cmd("room.cancel", { task: task.id }),
    onMutate: () => setStopping(true),
    onError: (error) => {
      setStopping(false);
      toast("Could not stop", { detail: error.message, tone: "error" });
    },
  });

  const answer = useMutation<{ item: RoomItem }, ApiRequestError, { item: string; option: string }>({
    mutationFn: (input) => cmd("room.permission", { task: task.id, ...input }),
    onSuccess: ({ item }) => dispatch({ type: "local", item }),
    onError: (error) => toast("Could not answer", { detail: error.message, tone: "error" }),
  });
  const onPermission = useCallback(
    (item: string, option: string) => answer.mutate({ item, option }),
    [answer.mutate],
  );

  // Esc anywhere in the room stops the agent, unless something inside (a popup, a menu, a dialog) used it.
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.target instanceof Element && event.target.closest('dialog, [role="menu"]')) return;
    if (busy && !cancel.isPending && !stopping) {
      // Stopping the agent is what Esc did; a drawer around the room must not also close.
      event.preventDefault();
      cancel.mutate();
    }
  }

  return (
    <section
      aria-label="Task room"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 outline-none"
    >
      {state.connection === "reconnecting" && (
        <p
          role="status"
          className="rounded-md border border-amber-line bg-amber-wash px-3 py-1 text-sm text-amber"
        >
          Lost the connection to the room. Reconnecting.
        </p>
      )}
      <Timeline
        state={state}
        onLoadOlder={loadOlder}
        onLoadAround={loadAround}
        onLoadNewer={loadNewer}
        onJumpToLatest={jumpToLatest}
        jumpSignal={jumpSignal}
        onPermission={onPermission}
        answering={answer.isPending ? answer.variables?.item : undefined}
        task={{ id: task.id, folder: task.folder }}
        owner={owner}
        focusItem={focusItem}
        onFocused={onFocused}
        foldSteps={foldSteps}
      />
      <Composer
        taskId={task.id}
        agents={state.agents}
        onSent={(item) => {
          dispatch({ type: "local", item });
          if (state.newer) jumpToLatest();
        }}
        onDrop={(id) => dispatch({ type: "drop", id })}
        onCancel={() => cancel.mutate()}
        cancelling={cancel.isPending || stopping}
        starting={starting}
        draft={draft}
      />
    </section>
  );
}
