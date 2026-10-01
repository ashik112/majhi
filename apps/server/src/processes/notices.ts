import type { ProcessInfo } from "@majhi/shared";
import { duration, endLine, label } from "./text.ts";

/**
 * When a background process's end wakes its agent (5.15), and what the agent reads. Pure, so the
 * rules are tested alone. An end wakes at most once, only the agent that started it, and never
 * when a newer run of the same thing started after it: that newer run's result is what counts.
 */

/** Lines of output per process in a wake message. */
const WAKE_LINES = 30;
/** Characters of output in a wake message, at most, shared by every process in it. */
const WAKE_CHARS = 4_000;
/** Lines per process when several ended together. */
const MERGED_LINES = 10;

/**
 * The room item that records one end. Its id is the same however often the end is reported, so
 * a stored one means the end was handled already, also after a restart.
 */
export function endItemId(p: Pick<ProcessInfo, "id" | "startedAt">): string {
  return `process-end:${p.id}:${p.startedAt}`;
}

/** Whether two reports are about the same run of a process. */
export function sameRun(a: ProcessInfo, b: ProcessInfo): boolean {
  return a.task === b.task && a.id === b.id && a.startedAt === b.startedAt;
}

/**
 * The newest run in `all` of the same name or command, in the same task, that started after `p`.
 * A restart reuses the id with a later start, so it counts too. Undefined when `p` is current.
 */
export function supersededBy(p: ProcessInfo, all: readonly ProcessInfo[]): ProcessInfo | undefined {
  let newest: ProcessInfo | undefined;
  for (const q of all) {
    if (q.task !== p.task || sameRun(q, p)) continue;
    if (q.name !== p.name && q.command !== p.command) continue;
    if (Date.parse(q.startedAt) <= Date.parse(p.startedAt)) continue;
    if (newest === undefined || Date.parse(q.startedAt) > Date.parse(newest.startedAt)) newest = q;
  }
  return newest;
}

/** Splits ended runs into the ones still current and the ones a newer run replaced. */
export function splitCurrent(
  ends: readonly ProcessInfo[],
  all: readonly ProcessInfo[],
): { current: ProcessInfo[]; replaced: ProcessInfo[] } {
  const current: ProcessInfo[] = [];
  const replaced: ProcessInfo[] = [];
  // One end may also replace another that waits with it.
  const known = [...all, ...ends];
  for (const e of ends) (supersededBy(e, known) === undefined ? current : replaced).push(e);
  return { current, replaced };
}

const GUIDANCE =
  "Reply only if this changes what you do. Do not mention other agents just to report status or to say you are waiting: a mention wakes them. The majhi-processes tool has the full output.";

function endedAt(p: ProcessInfo): number {
  return Date.parse(p.endedAt ?? p.startedAt);
}

function output(p: ProcessInfo, lines: number, chars: number): string {
  let tail = p.tail.slice(-lines).join("\n");
  if (tail.length > chars) tail = `…${tail.slice(-chars)}`;
  return tail === "" ? "It printed nothing." : `Last lines of its output:\n\`\`\`\n${tail}\n\`\`\``;
}

function headline(p: ProcessInfo): string {
  const took = p.endedAt === undefined ? "" : ` after ${duration(p.startedAt, p.endedAt)}`;
  return `${p.id}, ${label(p)}, ${endLine(p)}${took}`;
}

/**
 * The one prompt for every current end that waits for an agent, newest first. `replaced` are
 * ends a newer run made old: named, so the agent knows to ignore them, but not shown.
 */
export function noticeText(current: readonly ProcessInfo[], replaced: readonly ProcessInfo[] = []): string {
  const ends = [...current].sort((a, b) => endedAt(b) - endedAt(a));
  const old =
    replaced.length === 0
      ? []
      : [
          `Older runs ${replaced.map((p) => p.id).join(", ")} also ended, but newer runs replaced them: ignore their results.`,
        ];
  const [only] = ends;
  if (ends.length === 1 && only !== undefined) {
    return [
      `Your background process ${headline(only)}. It is the latest run of that command.`,
      output(only, WAKE_LINES, WAKE_CHARS),
      ...old,
      GUIDANCE,
    ].join("\n\n");
  }
  const chars = Math.floor(WAKE_CHARS / Math.max(1, ends.length));
  return [
    `${ends.length} of your background processes ended. Newest first; each is the latest run of its command, so these results are current.`,
    ...ends.map((p, i) => `${i + 1}. ${headline(p)}.\n${output(p, MERGED_LINES, chars)}`),
    ...old,
    GUIDANCE,
  ].join("\n\n");
}
