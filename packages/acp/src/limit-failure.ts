import type { ToolId } from "@majhi/shared";
import { getTool } from "./tools/index.ts";

/**
 * Whether a run failed because its account hit a usage, rate or credit limit (5.7), and when the
 * CLI says it resets. The words per CLI live in its registry entry (`limitShapes`); the reset is
 * read here from the forms both CLIs use. Checked on errors and on the first line of a turn's text,
 * never on an agent's ordinary output: agents write about rate limits too.
 */
export interface LimitFailure {
  /** The CLI's message, first line. */
  detail: string;
  /** When the account works again, if the message names it (ISO). */
  resetsAt?: string;
}

/** Longer first lines are an agent's prose, not a CLI's error. */
const LINE_MAX = 400;
const DETAIL_MAX = 200;

/**
 * Context-window errors ("input length and max_tokens exceed context limit") and overloads (529)
 * mention limits and 429s in passing. They are the run's own to recover from, not the account's.
 */
const NOT_A_LIMIT =
  /context (window|length|limit)|prompt is too long|too many tokens|maximum context|context_length_exceeded|input is too long|\b529\b|overloaded/i;

/** Text of an error and of the details an ACP error carries in `data`. */
function errorTexts(err: unknown): string[] {
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === "string" && v.trim() !== "") out.push(v);
  };
  if (typeof err === "string") add(err);
  else if (err instanceof Error) add(err.message);
  const data: unknown = typeof err === "object" && err !== null && "data" in err ? err.data : undefined;
  if (typeof data === "string") add(data);
  else if (typeof data === "object" && data !== null) {
    for (const key of ["details", "message", "error"] as const) {
      const v = (data as Record<string, unknown>)[key];
      if (typeof v === "object" && v !== null && "message" in v) add(v.message);
      else add(v);
    }
  }
  return out;
}

function firstLine(text: string): string {
  return text.trim().split("\n", 1)[0]?.trim() ?? "";
}

function matches(text: string, shapes: readonly RegExp[]): boolean {
  return !NOT_A_LIMIT.test(text) && shapes.some((re) => re.test(text));
}

function build(text: string, now: Date, zone: string): LimitFailure {
  const line = firstLine(text);
  const detail = line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 1)}…` : line;
  const reset = parseReset(text, now, zone);
  return reset === undefined ? { detail } : { detail, resetsAt: reset.toISOString() };
}

export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Whether a failed prompt or start failed on the account's limit. `lastText` is the agent's last
 * message in the failed turn: the CLI prints its limit line there and the prompt then fails with
 * a generic error. Only its first line counts, when it is short and in the CLI's own form.
 * `zone` is where a time without a zone is read; default the server's.
 */
export function limitFailure(
  err: unknown,
  lastText: string | undefined,
  tool: ToolId,
  now: Date,
  zone: string = localZone(),
): LimitFailure | undefined {
  const shapes = getTool(tool).limitShapes;
  for (const text of errorTexts(err)) {
    if (matches(text, shapes.error)) return build(text, now, zone);
  }
  const line = firstLine(lastText ?? "");
  if (line !== "" && line.length <= LINE_MAX && matches(line, shapes.line)) return build(line, now, zone);
  return undefined;
}

/**
 * A turn that ended normally can still be the CLI's limit result, which claude-agent-acp may hand
 * back as the turn's text. Only a final text that is one short line in the CLI's own form counts.
 */
export function limitLine(
  text: string,
  tool: ToolId,
  now: Date,
  zone: string = localZone(),
): LimitFailure | undefined {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.includes("\n") || trimmed.length > LINE_MAX) return undefined;
  return matches(trimmed, getTool(tool).limitShapes.line) ? build(trimmed, now, zone) : undefined;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function unitMs(unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("ms") || u.startsWith("milli")) return UNIT_MS.ms ?? 1;
  return UNIT_MS[u[0] ?? "s"] ?? 1000;
}

/** "2 days 3 hours 4 minutes", "20s", "1m30.5s", "6m0s": a run of number and unit pairs. */
function parseDuration(tail: string): number | undefined {
  const pair =
    /^\s*(?:,\s*|and\s+)?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/i;
  let rest = tail;
  let total = 0;
  let found = false;
  for (let m = pair.exec(rest); m !== null; m = pair.exec(rest)) {
    total += Number(m[1]) * unitMs(m[2] ?? "s");
    found = true;
    rest = rest.slice(m[0].length);
  }
  return found ? total : undefined;
}

/** Wall-clock parts of an instant in a zone. */
function zoneParts(
  ms: number,
  zone: string,
): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const get = (type: string): number => Number(f.formatToParts(ms).find((p) => p.type === type)?.value);
  return {
    y: get("year"),
    mo: get("month"),
    d: get("day"),
    h: get("hour"),
    mi: get("minute"),
    s: get("second"),
  };
}

/** The zone's offset from UTC at an instant, in ms. */
function zoneOffset(ms: number, zone: string): number {
  const p = zoneParts(ms, zone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** The instant at which a zone's clock reads this date and time. Two passes cover a change of offset. */
function wallToInstant(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const first = wall - zoneOffset(wall, zone);
  return wall - zoneOffset(first, zone);
}

function validZone(zone: string, fallback: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return fallback;
  }
}

/** The next time the zone's clock reads `h:mi`, on `month`/`day` when given. */
function nextOccurrence(
  now: Date,
  zone: string,
  h: number,
  mi: number,
  date?: { mo: number; d: number; y?: number },
): number {
  const t = now.getTime();
  const p = zoneParts(t, zone);
  if (date === undefined) {
    const today = wallToInstant(p.y, p.mo, p.d, h, mi, zone);
    if (today > t) return today;
    const tomorrow = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
    return wallToInstant(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth() + 1,
      tomorrow.getUTCDate(),
      h,
      mi,
      zone,
    );
  }
  const year = date.y ?? p.y;
  const at = wallToInstant(year, date.mo, date.d, h, mi, zone);
  return at > t || date.y !== undefined ? at : wallToInstant(year + 1, date.mo, date.d, h, mi, zone);
}

/**
 * When the message says the account works again: an epoch after `|` ("usage limit reached|1760000000"),
 * a wait ("try again in 2 days 3 hours 4 minutes", "in 20s"), or a clock time ("resets 3pm
 * (Europe/Berlin)", "try again at 3:40 PM", with a date when one is given), as the next such time.
 * Undefined when it names none, or names one that has passed.
 */
export function parseReset(text: string, now: Date, zone: string = localZone()): Date | undefined {
  const t = now.getTime();
  const epoch = /\|\s*(\d{10}|\d{13})(?!\d)/.exec(text);
  if (epoch?.[1] !== undefined) {
    const n = Number(epoch[1]);
    const at = epoch[1].length === 10 ? n * 1000 : n;
    return at > t ? new Date(at) : undefined;
  }
  const wait = /\b(?:again|retry|resets?|wait)\s+in\s+(.+)/i.exec(text);
  if (wait?.[1] !== undefined) {
    const ms = parseDuration(wait[1]);
    if (ms !== undefined) return new Date(t + ms);
  }
  const clock =
    /\b(?:resets?(?:\s+at)?|(?:try|retry) again at|(?:available|back)(?: again)? at)\s+(.+)/i.exec(text);
  if (clock?.[1] === undefined) return undefined;
  let tail = clock[1];
  let at = zone;
  const zoneMatch = /\(([A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+-]+)*)\)/.exec(tail);
  if (zoneMatch?.[1] !== undefined) {
    at = validZone(zoneMatch[1], zone);
    tail = tail.replace(zoneMatch[0], " ");
  }
  let date: { mo: number; d: number; y?: number } | undefined;
  const dateMatch =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i.exec(
      tail,
    );
  if (dateMatch?.[1] !== undefined && dateMatch[2] !== undefined) {
    date = { mo: MONTHS.indexOf(dateMatch[1].toLowerCase()) + 1, d: Number(dateMatch[2]) };
    if (dateMatch[3] !== undefined) date.y = Number(dateMatch[3]);
    tail = tail.replace(dateMatch[0], " ");
  }
  let h: number;
  let mi: number;
  const ampm = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i.exec(tail);
  const h24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(tail);
  if (ampm?.[1] !== undefined && ampm[3] !== undefined) {
    h = (Number(ampm[1]) % 12) + (ampm[3].toLowerCase() === "p" ? 12 : 0);
    mi = Number(ampm[2] ?? 0);
  } else if (h24?.[1] !== undefined && h24[2] !== undefined) {
    h = Number(h24[1]);
    mi = Number(h24[2]);
  } else return undefined;
  const result = nextOccurrence(now, at, h, mi, date);
  return result > t ? new Date(result) : undefined;
}
