import { isCaptainLane, PAGE_PATH, PRIVATE, type Task } from "@majhi/shared";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useCaptainStatus } from "@/lib/captain-queries";

/**
 * A captain thread is not a task, so its old addresses (/t/HOO-2, /chats/HOO-2, a task link in a
 * message) open the Captain page on that workspace's thread instead of a task screen. True while
 * the task is a thread, so the caller can show nothing meanwhile.
 */
export function useLaneRedirect(task: Task | undefined): boolean {
  const navigate = useNavigate();
  const lane = task !== undefined && isCaptainLane(task);
  const org = task?.org ?? PRIVATE;
  const status = useCaptainStatus().data;
  // Both sessions of a workspace are its one thread.
  useEffect(() => {
    if (lane && status !== undefined)
      void navigate({ to: PAGE_PATH.captain, search: { thread: org }, replace: true });
  }, [lane, status, org, navigate]);
  return lane;
}
