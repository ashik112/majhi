import type { RoomItem } from "@majhi/shared";

/**
 * What the dock shows: the items that wait for the owner. An open question comes first and hides
 * "Ready to ship", so two primary buttons never compete and the answer is asked for first.
 */
export function dockItems(items: readonly RoomItem[], status: string | undefined): RoomItem[] {
  // A card that draws nothing for the task's state (a pause on a task that is not paused, a reply
  // row on a task in review or done) must not leave an empty box in the dock. A question with no
  // words still draws: its row says who asked.
  const draws = (i: RoomItem) =>
    i.type === "paused"
      ? status === undefined || status === "paused"
      : i.type === "owner-question"
        ? status === undefined || (status !== "done" && (i.choices.length > 0 || status !== "review"))
        : true;
  const waiting = items.filter((i) => waitsForOwner(i) && draws(i));
  const asked = waiting.some(
    (i) => ANSWERS.has(i.type) || (i.type === "owner-question" && i.choices.length > 0),
  );
  const shown = asked ? waiting.filter((i) => i.type !== "review") : waiting;
  const rank = (i: RoomItem) =>
    ANSWERS.has(i.type) || i.type === "owner-question"
      ? 0
      : i.type === "review" || i.type === "paused"
        ? 2
        : 1;
  return [...shown].sort((a, b) => rank(a) - rank(b));
}

/** Items that are a question to the owner. */
const ANSWERS: ReadonlySet<RoomItem["type"]> = new Set(["ask", "choice", "approval", "permission"]);

/** Items that wait for the owner's answer: shown in the "Needs you" dock, not in the log. */
export function waitsForOwner(item: RoomItem): boolean {
  switch (item.type) {
    case "permission":
    case "approval":
    case "ask":
    case "choice":
    case "review":
    case "paused":
    case "owner-question":
      return item.state === "pending";
    default:
      return false;
  }
}
