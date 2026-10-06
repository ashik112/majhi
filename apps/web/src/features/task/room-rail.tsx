import type { AgentLive, Task } from "@majhi/shared";
import { ChevronLeft, ChevronRight, GitBranch } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { cn } from "@/lib/cn";
import { GLASS, GLASS_STRONG } from "@/lib/glass";
import { agentsBusy } from "./model";

const BUTTON =
  "grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent";

/**
 * Where the right column goes when the window is narrower than 1300 px: a slim rail with a button that
 * opens it, the first agent of the room and the branch. The column itself opens over the page.
 */
export function RoomRail({
  task,
  agents,
  onOpen,
}: {
  task: Pick<Task, "team">;
  agents: readonly AgentLive[];
  onOpen: () => void;
}) {
  const first = task.team[0];
  return (
    <div
      className={cn("flex w-11 shrink-0 flex-col items-center gap-1 self-start rounded-xl py-2", GLASS)}
      role="toolbar"
      aria-label="Task details"
    >
      <button
        type="button"
        onClick={onOpen}
        title="Open In this room and branches"
        aria-label="Open In this room and branches"
        className={BUTTON}
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
      </button>
      {first !== undefined && (
        <button
          type="button"
          onClick={onOpen}
          title={`@${first} in this room`}
          aria-label={`@${first} in this room`}
          className={BUTTON}
        >
          <AgentAvatar id={first} size={22} working={agentsBusy(agents)} decorative />
        </button>
      )}
      <button
        type="button"
        onClick={onOpen}
        title="Branch and worktree"
        aria-label="Branch and worktree"
        className={BUTTON}
      >
        <GitBranch aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}

/** The right column over the page: a click on the arrow or Esc folds it again. */
export function RoomOverlay({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className={cn(
        "absolute inset-y-0 right-0 z-30 flex w-[344px] max-w-full flex-col gap-1 overflow-hidden rounded-2xl p-2",
        GLASS_STRONG,
      )}
    >
      <button
        type="button"
        onClick={onClose}
        title="Fold the column"
        aria-label="Fold the column"
        className={cn(BUTTON, "self-end")}
      >
        <ChevronRight aria-hidden="true" className="size-4" />
      </button>
      {children}
    </div>
  );
}
