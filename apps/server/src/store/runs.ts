import { and, desc, eq, isNotNull, isNull, max } from "drizzle-orm";
import type { Db } from "./db.ts";
import { audit, runs, taskAllowances } from "./schema.ts";

export interface RunRow {
  id: number;
  task: string;
  agent: string;
  sessionId: string | undefined;
  startedAt: string;
  endedAt: string | undefined;
  stopReason: string | undefined;
  model: string | undefined;
  effort: string | undefined;
  inFlight: boolean;
  checkpoint: number;
  decisionId: string | undefined;
}

/** One row per agent process, for history and for resuming a session after a restart. */
export class RunRepo {
  constructor(private readonly db: Db) {}

  start(input: {
    task: string;
    agent: string;
    sessionId: string;
    model?: string | undefined;
    effort?: string | undefined;
    at: string;
  }): number {
    const row = this.db
      .insert(runs)
      .values({
        task: input.task,
        agent: input.agent,
        sessionId: input.sessionId,
        startedAt: input.at,
        model: input.model ?? null,
        effort: input.effort ?? null,
      })
      .returning({ id: runs.id })
      .get();
    return row.id;
  }

  end(id: number, stopReason: string, at: string): void {
    this.db
      .update(runs)
      .set({ endedAt: at, stopReason })
      .where(and(eq(runs.id, id), isNull(runs.endedAt)))
      .run();
  }

  /** Marks every run that never ended, like after a crash or restart. Returns how many. */
  endAllLive(stopReason: string, at: string): number {
    return this.db.update(runs).set({ endedAt: at, stopReason }).where(isNull(runs.endedAt)).run().changes;
  }

  /** The newest ACP session id for the pair, to resume it. A session that was handed off is never resumed. */
  lastSessionId(task: string, agent: string): string | undefined {
    const row = this.db
      .select({ sessionId: runs.sessionId, stopReason: runs.stopReason })
      .from(runs)
      .where(and(eq(runs.task, task), eq(runs.agent, agent), isNotNull(runs.sessionId)))
      .orderBy(desc(runs.id))
      .limit(1)
      .get();
    if (row === undefined || row.stopReason === "handoff") return undefined;
    return row.sessionId ?? undefined;
  }

  /** True when the agent had a session in this task before. */
  ranBefore(task: string, agent: string): boolean {
    return (
      this.db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.task, task), eq(runs.agent, agent)))
        .limit(1)
        .get() !== undefined
    );
  }

  /** A turn started (true), or ended on its own or by the owner (false). Crashes and pauses leave it set. */
  setInFlight(task: string, agent: string, runId: number, value: boolean): void {
    if (value) {
      this.db.update(runs).set({ inFlight: 1 }).where(eq(runs.id, runId)).run();
      return;
    }
    // Every run of the pair: an older run cut by a crash is continued by this one.
    this.db
      .update(runs)
      .set({ inFlight: 0 })
      .where(and(eq(runs.task, task), eq(runs.agent, agent)))
      .run();
  }

  /** (task, agent) pairs with a turn that was cut and has not continued yet. */
  interrupted(): { task: string; agent: string }[] {
    return this.db
      .selectDistinct({ task: runs.task, agent: runs.agent })
      .from(runs)
      .where(eq(runs.inFlight, 1))
      .all();
  }

  setCheckpoint(id: number, checkpoint: number, roomSeq: number): void {
    this.db.update(runs).set({ checkpoint, roomSeq }).where(eq(runs.id, id)).run();
  }

  /** The task's newest checkpoint number and the room position at it; 0 and 0 before the first. */
  lastCheckpoint(task: string): { checkpoint: number; roomSeq: number } {
    const top = this.db
      .select({ n: max(runs.checkpoint) })
      .from(runs)
      .where(eq(runs.task, task))
      .get();
    const n = top?.n ?? 0;
    if (n === 0) return { checkpoint: 0, roomSeq: 0 };
    const row = this.db
      .select({ roomSeq: runs.roomSeq })
      .from(runs)
      .where(and(eq(runs.task, task), eq(runs.checkpoint, n)))
      .orderBy(desc(runs.id))
      .limit(1)
      .get();
    return { checkpoint: n, roomSeq: row?.roomSeq ?? 0 };
  }

  /** What the decision provider picked for this run, and the decision's id. */
  setPick(
    id: number,
    pick: { model?: string | undefined; effort?: string | undefined; decisionId: string },
  ): void {
    this.db
      .update(runs)
      .set({
        decisionId: pick.decisionId,
        ...(pick.model === undefined ? {} : { model: pick.model }),
        ...(pick.effort === undefined ? {} : { effort: pick.effort }),
      })
      .where(eq(runs.id, id))
      .run();
  }

  forTask(task: string): RunRow[] {
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.task, task))
      .orderBy(runs.id)
      .all()
      .map((r) => ({
        id: r.id,
        task: r.task,
        agent: r.agent,
        sessionId: r.sessionId ?? undefined,
        startedAt: r.startedAt,
        endedAt: r.endedAt ?? undefined,
        stopReason: r.stopReason ?? undefined,
        model: r.model ?? undefined,
        effort: r.effort ?? undefined,
        inFlight: r.inFlight === 1,
        checkpoint: r.checkpoint,
        decisionId: r.decisionId ?? undefined,
      }));
  }
}

export interface AuditRow {
  task: string;
  agent: string;
  kind: string;
  title: string;
  decision: "allow" | "deny" | "cancelled";
  by: "owner" | "rule";
  at: string;
}

/** Every permission decision, and the "allow for this task" choices. */
export class PermissionRepo {
  constructor(private readonly db: Db) {}

  log(row: AuditRow): void {
    this.db.insert(audit).values(row).run();
  }

  audit(task: string): AuditRow[] {
    return this.db
      .select()
      .from(audit)
      .where(eq(audit.task, task))
      .orderBy(audit.id)
      .all()
      .map((r) => ({
        task: r.task,
        agent: r.agent,
        kind: r.kind,
        title: r.title,
        decision: r.decision as AuditRow["decision"],
        by: r.by as AuditRow["by"],
        at: r.at,
      }));
  }

  allow(task: string, kind: string): void {
    this.db.insert(taskAllowances).values({ task, kind }).onConflictDoNothing().run();
  }

  allowed(task: string, kind: string): boolean {
    return (
      this.db
        .select({ kind: taskAllowances.kind })
        .from(taskAllowances)
        .where(and(eq(taskAllowances.task, task), eq(taskAllowances.kind, kind)))
        .get() !== undefined
    );
  }
}
