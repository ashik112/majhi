import { PRIVATE } from "@majhi/shared";
import type Database from "better-sqlite3";

/**
 * What client economics reads, one query per measure and workspace-grouped. Work tasks only: the
 * chats (the owner's, the boss's, a captain lane's) are not client work. Read only.
 */

/** Audit kinds that mean a task shipped. */
export const SHIP_KINDS = ["push", "merge", "merge+push", "mr"] as const;
const SHIP_IN = SHIP_KINDS.map((k) => `'${k}'`).join(", ");

/** A run that never closed counts at most this long, so a crashed one does not read as a day of work. */
const RUN_CAP_MINUTES = 720;

export interface Count {
  org: string;
  n: number;
}

/** Tasks that shipped in a span, per workspace. A task that pushed and then merged counts once. */
export function shippedTasks(db: Database.Database, from: string, to: string): Count[] {
  return db
    .prepare(
      `SELECT COALESCE(a.org, ?) AS org, COUNT(DISTINCT a.task) AS n
         FROM audit a
        WHERE a.at >= ? AND a.at < ? AND a.kind IN (${SHIP_IN}) AND a.decision = 'done'
        GROUP BY COALESCE(a.org, ?)`,
    )
    .all(PRIVATE, from, to, PRIVATE) as Count[];
}

/** When each workspace last shipped a task. */
export function lastShipped(db: Database.Database): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT COALESCE(a.org, ?) AS org, MAX(a.at) AS at
         FROM audit a
        WHERE a.kind IN (${SHIP_IN}) AND a.decision = 'done'
        GROUP BY COALESCE(a.org, ?)`,
    )
    .all(PRIVATE, PRIVATE) as { org: string; at: string }[];
  return new Map(rows.map((r) => [r.org, r.at]));
}

/** Minutes agents worked on tasks, per workspace, counting only the part of a run inside the span. */
export function agentMinutes(
  db: Database.Database,
  from: string,
  to: string,
  now: string,
): { org: string; minutes: number }[] {
  return db
    .prepare(
      `SELECT COALESCE(t.org, ?) AS org,
              SUM(MIN(?, MAX(0, (MIN(julianday(COALESCE(r.ended_at, ?)), julianday(?)) - MAX(julianday(r.started_at), julianday(?))) * 1440))) AS minutes
         FROM runs r JOIN tasks t ON t.id = r.task
        WHERE r.started_at < ? AND COALESCE(r.ended_at, ?) > ? AND t.kind <> 'chat'
        GROUP BY COALESCE(t.org, ?)`,
    )
    .all(PRIVATE, RUN_CAP_MINUTES, now, to, from, to, now, from, PRIVATE) as { org: string; minutes: number }[];
}

/** The tasks of a workspace the owner spent the most actions on in a span (messages, approvals, ships). */
export function ownerHotTasks(
  db: Database.Database,
  org: string,
  from: string,
  to: string,
  limit: number,
): { id: string; title: string; actions: number }[] {
  return db
    .prepare(
      `SELECT t.id AS id, t.title AS title, SUM(x.n) AS actions FROM (
         SELECT task, COUNT(*) AS n FROM room_items WHERE type = 'owner' AND at >= ? AND at < ? GROUP BY task
         UNION ALL
         SELECT task, COUNT(*) AS n FROM audit WHERE by = 'owner' AND at >= ? AND at < ? GROUP BY task
       ) x JOIN tasks t ON t.id = x.task
       WHERE COALESCE(t.org, ?) = ? AND t.kind <> 'chat'
       GROUP BY t.id ORDER BY actions DESC, t.id LIMIT ?`,
    )
    .all(from, to, from, to, PRIVATE, org, limit) as { id: string; title: string; actions: number }[];
}

/** What the owner did that took their time, per workspace: messages to a task's room, and approvals and ships they made. */
export interface OwnerActions {
  org: string;
  messages: number;
  ships: number;
  approvals: number;
}

export function ownerActions(db: Database.Database, from: string, to: string): OwnerActions[] {
  const byOrg = new Map<string, OwnerActions>();
  const slot = (org: string): OwnerActions => {
    let s = byOrg.get(org);
    if (s === undefined) {
      s = { org, messages: 0, ships: 0, approvals: 0 };
      byOrg.set(org, s);
    }
    return s;
  };
  const messages = db
    .prepare(
      `SELECT COALESCE(t.org, ?) AS org, COUNT(*) AS n
         FROM room_items i JOIN tasks t ON t.id = i.task
        WHERE i.type = 'owner' AND i.at >= ? AND i.at < ? AND t.kind <> 'chat'
        GROUP BY COALESCE(t.org, ?)`,
    )
    .all(PRIVATE, from, to, PRIVATE) as Count[];
  for (const m of messages) slot(m.org).messages = m.n;
  const audit = db
    .prepare(
      `SELECT COALESCE(a.org, ?) AS org, (a.kind IN (${SHIP_IN})) AS ship, COUNT(*) AS n
         FROM audit a
        WHERE a.by = 'owner' AND a.at >= ? AND a.at < ?
        GROUP BY COALESCE(a.org, ?), (a.kind IN (${SHIP_IN}))`,
    )
    .all(PRIVATE, from, to, PRIVATE) as { org: string; ship: number; n: number }[];
  for (const a of audit) {
    if (a.ship === 1) slot(a.org).ships += a.n;
    else slot(a.org).approvals += a.n;
  }
  return [...byOrg.values()];
}
