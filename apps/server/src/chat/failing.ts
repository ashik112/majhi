/**
 * Minutes spent failing between two moments: a stretch between the watch going green and firing again does not count.
 * One pure function for the incident report and the weekly client report, so both say the same time.
 */
export function failingMinutes(
  began: string,
  end: string,
  timeline: readonly { kind: string; at: string }[],
): { minutes: number; paused: boolean } {
  let total = 0;
  let from: string | undefined = began;
  let paused = false;
  for (const t of timeline.toSorted((a, b) => a.at.localeCompare(b.at))) {
    if (t.at <= began || t.at >= end) continue;
    if (t.kind === "resolved" && from !== undefined) {
      total += Date.parse(t.at) - Date.parse(from);
      from = undefined;
      paused = true;
    } else if (t.kind === "reopened" && from === undefined) from = t.at;
  }
  if (from !== undefined) total += Date.parse(end) - Date.parse(from);
  return { minutes: Math.round(total / 60_000), paused };
}
