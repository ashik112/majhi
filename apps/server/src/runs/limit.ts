/**
 * The words of an account's usage limit in the room and on the paused card (SPEC 5.7). Pure text
 * functions, so the run manager and the lift say the same thing.
 */

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "3:40 PM" for a reset today, "Fri 3:40 PM" for a later day, in the server's time zone. */
export function limitClock(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "the reset";
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return sameDay(at, now) ? time : `${at.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
}

/** The paused card's text: "claude-acme is at its usage limit until 3:40 PM". */
export function limitPauseText(account: string, until: string, now: Date): string {
  return `${account} is at its usage limit until ${limitClock(until, now)}`;
}

/** The one room line when the fallback takes over. */
export function handedOffLine(from: string, to: string, until: string, now: Date): string {
  return `@${from} hit its usage limit (resets ${limitClock(until, now)}). @${to} continues from the checkpoint.`;
}

/** Said once when an account's limit passed but the org does not resume by itself. */
export function limitResetHeldLine(account: string): string {
  return `${account}'s limit reset. Automatic resume is off for this org, so resume the task when you are ready.`;
}
