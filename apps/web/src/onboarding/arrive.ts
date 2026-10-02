import { useEffect } from "react";

/**
 * The journey ends on the board with the new-task box open. The box lives inside the app, which
 * mounts only once the journey closes, so the journey leaves a note here and the app reads it once.
 */
let pending = false;

export function openNewTaskOnArrival(): void {
  pending = true;
}

/** Opens the new-task box once, right after the journey hands over to the app. */
export function useArrivalNewTask(open: () => void): void {
  useEffect(() => {
    if (!pending) return;
    pending = false;
    open();
  }, [open]);
}
