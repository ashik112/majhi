import { createHash } from "node:crypto";
import {
  CASE_MAX_CALLS,
  CASE_MAX_MS,
  type CaseCommand,
  type CaseFollowUp,
  type CaseRecord,
} from "@majhi/shared";

/**
 * The rules of one case, on its record and nothing else (docs/briefs/case-flow.md). Pure: the clock arrives as an
 * argument and nothing is stored here. The case service reads the record from the task, asks these functions, and
 * writes back what they return. Every bound the brief names is checked here, in code, never left to the captain.
 */

/** A new record for a client's report. */
export function newCase(input: {
  room: string;
  client: string;
  symptom: string;
  at: string;
  day: string;
}): CaseRecord {
  return {
    room: input.room,
    client: input.client.slice(0, 100),
    openedAt: input.at,
    day: input.day,
    symptom: input.symptom.slice(0, 600),
    calls: 0,
    ms: 0,
    commands: [],
    recoveries: [],
    checks: [],
    told: 0,
    followUps: [],
  };
}

/** `YYYY-MM-DD` of an instant in a time zone. */
export function dayOf(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** A short fingerprint of a command's output. Two outputs are the same result when their fingerprints are. */
export function fingerprint(output: string): string {
  return createHash("sha256").update(output).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// The bound

export type Over = "calls" | "time";

/**
 * Whether the case has used up what it may. `turnMs` is the time of the turn running now, which the record does not
 * hold yet. A case that stopped stays over until the owner gives it more.
 */
export function overBudget(record: CaseRecord, turnMs = 0): Over | undefined {
  if (record.calls > CASE_MAX_CALLS) return "calls";
  if (record.ms + turnMs >= CASE_MAX_MS) return "time";
  return undefined;
}

export function withCall(record: CaseRecord): CaseRecord {
  return { ...record, calls: record.calls + 1 };
}

export function withTime(record: CaseRecord, ms: number): CaseRecord {
  return { ...record, ms: record.ms + Math.max(0, ms) };
}

/** The owner let a stopped case go on: its counters start again. */
export function withMoreBudget(record: CaseRecord): CaseRecord {
  const { stopped: _stopped, ...rest } = record;
  return { ...rest, calls: 0, ms: 0 };
}

export function withStop(record: CaseRecord, at: string, why: string): CaseRecord {
  return { ...record, stopped: { at, why: why.slice(0, 300) } };
}

export function overWords(over: Over): string {
  return over === "calls"
    ? `the case used its ${CASE_MAX_CALLS} tool calls`
    : `the case used its ${Math.round(CASE_MAX_MS / 60_000)} minutes of captain time`;
}

// ---------------------------------------------------------------------------
// Commands, recoveries, checks

/** The key a command is kept under: the connection and the line, so two hosts never share one. */
export function commandKey(connection: string, command: string): string {
  const spaced = [...command].map((ch) => (ch === "\t" || ch === "\n" || ch === "\r" ? " " : ch)).join("");
  return `${connection}: ${spaced
    .split(" ")
    .filter((w) => w !== "")
    .join(" ")}`.slice(0, 600);
}

/**
 * The earlier run of the same command that its answer still stands for: nothing was changed since it ran. The same
 * command is run again only after a recovery or another write, because only then can its result differ.
 */
export function repeatOf(record: CaseRecord, key: string): CaseCommand | undefined {
  const last = record.commands.findLast((c) => c.key === key);
  if (last === undefined) return undefined;
  return record.changedAt === undefined || record.changedAt <= last.at ? last : undefined;
}

export function withCommand(record: CaseRecord, command: CaseCommand): CaseRecord {
  return { ...record, commands: [...record.commands, command].slice(-100) };
}

/** A recovery runs once per case: the same action a second time asks the owner. */
export function recoveryDone(record: CaseRecord, action: string): boolean {
  return record.recoveries.includes(action);
}

export function withRecovery(record: CaseRecord, action: string, at: string): CaseRecord {
  return { ...record, recoveries: [...record.recoveries, action].slice(-20), changedAt: at };
}

/** A write that was not a recovery (the owner allowed it): later runs of a command may differ. */
export function withChange(record: CaseRecord, at: string): CaseRecord {
  return { ...record, changedAt: at };
}

/** A read that exited 0: the evidence a case closes on. */
export function withCheck(record: CaseRecord, what: string, at: string): CaseRecord {
  return { ...record, checks: [...record.checks, { at, what: what.slice(0, 300) }].slice(-30) };
}

/**
 * Whether the case may close as fixed: a read exited 0 after the last recovery or write. A case nothing changed
 * (the problem went away alone) closes on any read of it. Undefined when it may; else why not.
 */
export function notClosable(record: CaseRecord): string | undefined {
  if (record.closedAt !== undefined) return "The case is closed already.";
  const after = record.checks.filter((c) => record.changedAt === undefined || c.at > record.changedAt);
  if (after.length > 0) return undefined;
  return record.changedAt === undefined
    ? "Nothing was checked yet. Read the thing the client said fails, on the host, and close when it works."
    : "Something was changed after the last check. Read the thing the client said fails again, and close when it works.";
}

// ---------------------------------------------------------------------------
// What the client is told

/** Messages about an open case: two, and the closing message is on top of them. */
export function toldOut(record: CaseRecord, max: number): boolean {
  return record.told >= max;
}

export function withTold(record: CaseRecord): CaseRecord {
  return { ...record, told: record.told + 1 };
}

// ---------------------------------------------------------------------------
// Follow-ups and the summary

export function withFollowUp(record: CaseRecord, followUp: CaseFollowUp): CaseRecord {
  return { ...record, followUps: [...record.followUps, followUp].slice(-10) };
}

/** The lines of a summary, without blanks. A summary is three to six of them. */
export function summaryLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

export function badSummary(text: string): string | undefined {
  const n = summaryLines(text).length;
  return n >= 3 && n <= 6
    ? undefined
    : `The summary is ${n} lines. Write 3 to 6 lines: what broke, what you found, what you did, what to watch.`;
}
