import {
  type Deadline,
  DeadlineSchema,
  type DeadlinesList,
  type DeadlinesListInput,
  type DeadlineUpsertInput,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import { UserError } from "../errors.ts";
import { actorBy, type BusinessActor, canChange, canSee, missing, orgWhere, targetOrg } from "./scope.ts";
import { daysUntil, dueInstant, machineZone, parseDue, reminderInstants, stateOf } from "./time.ts";

/** Deadlines (SPEC 5.19): hackathons, grants, launches, client dates and renewals, each in its own time zone. */

interface Row {
  id: number;
  org: string | null;
  kind: string;
  title: string;
  due: string;
  tz: string;
  due_at: string;
  source: string;
  notes: string;
  lead_days: string;
  goal: string | null;
  finding: number | null;
  status: string;
  by: string;
  created_at: string;
  updated_at: string;
}

export interface DeadlinesDeps {
  db: Database.Database;
  now?: () => Date;
  orgExists: (org: string) => Promise<boolean>;
  findingExists?: (id: number) => boolean;
  changed?: () => void;
}

function leadDaysOf(raw: string): number[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

export class DeadlinesService {
  private readonly db: Database.Database;

  constructor(private readonly deps: DeadlinesDeps) {
    this.db = deps.db;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private row(id: number): Row | undefined {
    return this.db.prepare("SELECT * FROM deadlines WHERE id = ?").get(id) as Row | undefined;
  }

  /** The deadline as the screens and the agenda read it: moment, days left, state and next reminder. */
  private view(r: Row): Deadline {
    const now = this.now();
    const open = r.status === "open";
    const lead = leadDaysOf(r.lead_days);
    const next = open
      ? reminderInstants(r.due, r.tz, lead)
          .filter((d) => d.getTime() > now.getTime())
          .sort((a, b) => a.getTime() - b.getTime())[0]
      : undefined;
    return DeadlineSchema.parse({
      id: r.id,
      ...(r.org === null ? {} : { org: r.org }),
      kind: r.kind,
      title: r.title,
      due: r.due,
      tz: r.tz,
      allDay: parseDue(r.due).allDay,
      dueAt: r.due_at,
      source: r.source,
      notes: r.notes,
      leadDays: [...lead].sort((a, b) => b - a),
      ...(next === undefined ? {} : { nextReminder: next.toISOString() }),
      ...(r.goal === null ? {} : { goal: r.goal }),
      ...(r.finding === null ? {} : { finding: r.finding }),
      status: r.status,
      state: stateOf(r.due, r.tz, now, open),
      daysLeft: daysUntil(r.due, r.tz, now),
      by: r.by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }

  list(input: DeadlinesListInput, actor: BusinessActor): DeadlinesList {
    const scope = orgWhere("org", actor, input);
    const parts = [scope.sql];
    const args: unknown[] = [...scope.args];
    const status = input.status ?? "open";
    if (status !== "all") {
      parts.push("status = ?");
      args.push(status);
    }
    if (input.kind !== undefined) {
      parts.push("kind = ?");
      args.push(input.kind);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM deadlines WHERE ${parts.join(" AND ")} ORDER BY (status = 'open') DESC, due_at, id`,
      )
      .all(...args) as Row[];
    let out = rows.map((r) => this.view(r));
    if (input.withinDays !== undefined) {
      const within = input.withinDays;
      out = out.filter((d) => d.status !== "open" || d.daysLeft <= within);
    }
    return { deadlines: out.slice(0, input.limit) };
  }

  async upsert(input: DeadlineUpsertInput, actor: BusinessActor): Promise<Deadline> {
    const org = targetOrg(actor, input.org);
    if (org !== null && !(await this.deps.orgExists(org))) {
      throw new UserError(`Workspace ${org} does not exist.`, 404);
    }
    const existing = input.id === undefined ? undefined : this.row(input.id);
    if (input.id !== undefined && (existing === undefined || !canSee(actor, existing.org))) {
      throw missing("Deadline", input.id);
    }
    if (existing !== undefined && !canChange(actor, existing.org)) {
      throw new UserError(`Deadline ${existing.id} belongs to another scope.`, 409);
    }
    if (input.finding !== undefined && this.deps.findingExists?.(input.finding) === false) {
      throw missing("Finding", input.finding);
    }
    const tz = input.tz ?? existing?.tz ?? machineZone();
    const dueAt = dueInstant(input.due, tz).toISOString();
    const at = this.now().toISOString();
    const lead = JSON.stringify([...new Set(input.leadDays)].sort((a, b) => b - a));
    if (existing === undefined) {
      const info = this.db
        .prepare(
          `INSERT INTO deadlines (org, kind, title, due, tz, due_at, source, notes, lead_days, goal, finding, status, by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          org,
          input.kind,
          input.title,
          input.due,
          tz,
          dueAt,
          input.source,
          input.notes,
          lead,
          input.goal ?? null,
          input.finding ?? null,
          input.status,
          actorBy(actor),
          at,
          at,
        );
      this.deps.changed?.();
      return this.view(this.row(Number(info.lastInsertRowid)) as Row);
    }
    this.db
      .prepare(
        `UPDATE deadlines SET org = ?, kind = ?, title = ?, due = ?, tz = ?, due_at = ?, source = ?, notes = ?, lead_days = ?,
           goal = ?, finding = ?, status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        org,
        input.kind,
        input.title,
        input.due,
        tz,
        dueAt,
        input.source,
        input.notes,
        lead,
        input.goal ?? null,
        input.finding ?? null,
        input.status,
        at,
        existing.id,
      );
    this.deps.changed?.();
    return this.view(this.row(existing.id) as Row);
  }

  remove(id: number, actor: BusinessActor): { id: number } {
    if (actor.kind !== "owner") throw new UserError("Only the owner deletes a deadline.", 409);
    if (this.row(id) === undefined) throw missing("Deadline", id);
    this.db.prepare("DELETE FROM deadlines WHERE id = ?").run(id);
    this.deps.changed?.();
    return { id };
  }
}
