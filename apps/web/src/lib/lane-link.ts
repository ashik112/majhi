import { isCaptainLane, PAGE_PATH, PRIVATE, type Task } from "@majhi/shared";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * A captain thread is not a task, so its old addresses (/t/HOO-2, /chats/HOO-2, a task link in a
 * message) open the Captain page on that workspace's thread instead of a task screen. True while
 * the task is a thread, so the caller can show nothing meanwhile.
 */
export function useLaneRedirect(task: Task | undefined): boolean {
  const navigate = useNavigate();
  const lane = task !== undefined && isCaptainLane(task);
  const org = task?.org ?? PRIVATE;
  useEffect(() => {
    if (lane) void navigate({ to: PAGE_PATH.captain, search: { thread: org }, replace: true });
  }, [lane, org, navigate]);
  return lane;
}
