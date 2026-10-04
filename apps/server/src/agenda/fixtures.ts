import type { Deadline, Finding, OwnerDecision } from "@majhi/shared";
import { daysUntil, dueInstant, stateOf } from "../deadlines/time.ts";

/** Sample rows for the agenda tests. Generic names only. */

export function decision(over: Partial<OwnerDecision> & { id: string }): OwnerDecision {
  return {
    kind: "ship",
    title: "Ship the invoice export",
    options: [],
    at: "2026-10-04T06:00:00.000Z",
    link: { kind: "captain" },
    ...over,
  };
}

export function deadline(
  over: Partial<Deadline> & { id: number; due?: string; tz?: string; now?: Date },
): Deadline {
  const { due = "2026-10-10", tz = "UTC", now = new Date("2026-10-04T08:00:00.000Z"), ...rest } = over;
  return {
    kind: "hackathon",
    title: "Spring hack signup",
    due,
    tz,
    allDay: !due.includes("T"),
    dueAt: dueInstant(due, tz).toISOString(),
    source: "",
    notes: "",
    leadDays: [14, 7, 1],
    status: "open",
    state: stateOf(due, tz, now, true),
    daysLeft: daysUntil(due, tz, now),
    by: "owner",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...rest,
  };
}

export function finding(over: Partial<Finding> & { id: number }): Finding {
  return {
    org: "acme",
    source: "security",
    title: "Outdated TLS setting",
    detail: "",
    evidence: [],
    severity: "high",
    dedupeKey: `k${over.id}`,
    status: "open",
    by: "captain",
    seen: 1,
    createdAt: "2026-10-03T12:00:00.000Z",
    updatedAt: "2026-10-03T12:00:00.000Z",
    lastSeen: "2026-10-03T12:00:00.000Z",
    ...over,
  };
}
