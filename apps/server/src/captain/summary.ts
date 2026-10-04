import type { CaptainAction, CaptainChore } from "@majhi/shared";

/**
 * One line per workspace for a day (SPEC 5.18): "shipped 2, tidied 8 memories, 1 thing for you".
 * Pure: it counts the day's log. "For you" is not read from the log: the caller passes the open
 * owner cards of the workspace (the same count as Needs you), since a card asked yesterday may be
 * answered today and one the captain never logged still waits.
 */
export function summaryOf(
  actions: readonly Pick<CaptainAction, "chore" | "outcome" | "text">[],
  forYou = 0,
): string {
  const done = (chore: CaptainChore, starts?: string) =>
    actions.filter(
      (a) => a.chore === chore && a.outcome === "done" && (starts === undefined || a.text.startsWith(starts)),
    ).length;
  const parts: string[] = [];
  const count = (n: number, one: string, many = `${one}s`) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  const shipped = done("ship", "Shipped");
  if (shipped > 0) parts.push(`shipped ${shipped}`);
  const cards = done("cards");
  if (cards > 0) parts.push(`answered ${cards} card${cards === 1 ? "" : "s"}`);
  const answers = done("questions", "Answered");
  if (answers > 0) parts.push(`answered ${answers} question${answers === 1 ? "" : "s"}`);
  const memories = done("memory");
  if (memories > 0) parts.push(`tidied ${memories} memor${memories === 1 ? "y" : "ies"}`);
  count(done("projects"), "new project");
  const triaged = done("triage");
  if (triaged > 0) parts.push(`set ${triaged} priorit${triaged === 1 ? "y" : "ies"}`);
  const cleaned = done("cleanup");
  if (cleaned > 0) parts.push(`cleaned up ${cleaned} old task${cleaned === 1 ? "" : "s"}`);
  if (forYou > 0) parts.push(`${forYou} thing${forYou === 1 ? "" : "s"} for you`);
  return parts.join(", ");
}
