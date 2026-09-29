import type { RoomItem, Task } from "@majhi/shared";
import { useMutation } from "@tanstack/react-query";
import { type KeyboardEvent, type ReactNode, useCallback } from "react";
import { useToast } from "@/components/ui/toast";
import { type ApiRequestError, cmd } from "@/lib/api";
import { Composer } from "./composer";
import { isBusy, type RoomAction, type RoomState } from "./model";
import { Timeline } from "./timeline";

/** The main column of a task: what the task says (`top`), the messages, and the composer. */
export function RoomPane({
  task,
  state,
  dispatch,
  loadOlder,
  top,
}: {
  task: Task;
  state: RoomState;
  dispatch: (action: RoomAction) => void;
  loadOlder: () => Promise<void>;
  top?: ReactNode;
}) {
  const toast = useToast();
  const busy = isBusy(state.agents);

  const cancel = useMutation<{ cancelled: string[] }, ApiRequestError, void>({
    mutationFn: () => cmd("room.cancel", { task: task.id }),
    onError: (error) => toast("Could not stop", { detail: error.message, tone: "error" }),
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
    if (busy && !cancel.isPending) {
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
      {top}
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
        onPermission={onPermission}
        answering={answer.isPending ? answer.variables?.item : undefined}
        task={{ id: task.id, folder: task.folder }}
      />
      <Composer
        taskId={task.id}
        agents={state.agents}
        onSent={(item) => dispatch({ type: "local", item })}
        onCancel={() => cancel.mutate()}
        cancelling={cancel.isPending}
      />
    </section>
  );
}
