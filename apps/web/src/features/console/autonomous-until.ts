/** The ways the owner ends Autonomous: when they say so, at 8:00, tonight, or after two hours. */
export type UntilChoice = "manual" | "morning" | "tonight" | "two-hours";

const HOUR = 3_600_000;

/** The next time the clock reads `hour:00` on the owner's own clock after `now`. */
function nextAt(hour: number, now: Date): Date {
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/** The instant a choice ends Autonomous (UTC ISO), or null for "until I turn it off". */
export function untilOf(choice: UntilChoice, now: Date): string | null {
  switch (choice) {
    case "manual":
      return null;
    case "morning":
      return nextAt(8, now).toISOString();
    case "tonight":
      return nextAt(23, now).toISOString();
    case "two-hours":
      return new Date(now.getTime() + 2 * HOUR).toISOString();
  }
}

/** "8:00", or "Tue 8:00" when it is not today. */
export function clockWord(at: Date, now: Date): string {
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(at);
  if (at.toDateString() === now.toDateString()) return time;
  const day = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(at);
  return `${day} ${time}`;
}
