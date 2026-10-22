import { caseOf, type Task } from "@majhi/shared";

/**
 * A task a client hears about: an incident, a case, one opened from a client's message or linked to a client chat.
 * Closing one tells a client or sends a report, so only a person or the task's own flow closes it, never a cascade.
 */
export function isClientFacing(task: Task): boolean {
  return (
    task.typing?.type === "incident" ||
    caseOf(task) !== undefined ||
    task.origin?.kind === "client" ||
    task.links.some((l) => l.type === "client")
  );
}
