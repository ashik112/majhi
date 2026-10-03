import { type EventsClientMessage, TYPING_REPORT_MS } from "@majhi/shared";
import { useEffect } from "react";

/**
 * Tells the server which task the owner types in, so the captain waits until they send or leave
 * (SPEC 5.18, Presence). It goes over the events socket, which `useServerEvents` binds here.
 */
let sender: ((message: EventsClientMessage) => void) | null = null;

export function bindTypingSender(next: ((message: EventsClientMessage) => void) | null): void {
  sender = next;
}

/**
 * While `typing` (the draft is not empty and the box has focus), reports `task` now and every
 * `TYPING_REPORT_MS`. Stopping, switching task and unmounting report "stopped".
 */
export function useTypingSignal(task: string, typing: boolean): void {
  useEffect(() => {
    if (!typing) return;
    const report = () => sender?.({ type: "typing", task });
    report();
    const timer = window.setInterval(report, TYPING_REPORT_MS);
    return () => {
      window.clearInterval(timer);
      sender?.({ type: "typing" });
    };
  }, [task, typing]);
}
