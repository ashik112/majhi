import {
  type PlanMember,
  PlanMemberSchema,
  type PlanOutcome,
  PlanOutcomeSchema,
  type TeamPlan,
  TeamPlanSchema,
} from "@majhi/shared";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db.ts";
import { taskPlans } from "./schema.ts";

export interface PlanRow {
  id: number;
  task: string;
  org: string | null;
  version: number;
  at: string;
  agent: string;
  plan: TeamPlan;
  team: PlanMember[];
  outcome: PlanOutcome | null;
}

export interface NewPlan {
  task: string;
  org: string | null;
  version: number;
  at: string;
  agent: string;
  plan: TeamPlan;
  team: PlanMember[];
}

/** Every version of every task's plan, with the tokens each agent used under it once known. */
export class PlanRepo {
  constructor(private readonly db: Db) {}

  add(plan: NewPlan): number {
    return this.db
      .insert(taskPlans)
      .values({
        task: plan.task,
        org: plan.org,
        version: plan.version,
        at: plan.at,
        agent: plan.agent,
        plan: JSON.stringify(plan.plan),
        team: JSON.stringify(plan.team),
      })
      .returning({ id: taskPlans.id })
      .get().id;
  }

  /** A task's plans, oldest version first. */
  forTask(task: string): PlanRow[] {
    return this.db
      .select()
      .from(taskPlans)
      .where(eq(taskPlans.task, task))
      .orderBy(asc(taskPlans.version))
      .all()
      .flatMap((r) => parseRow(r) ?? []);
  }

  setOutcome(id: number, outcome: PlanOutcome): void {
    this.db
      .update(taskPlans)
      .set({ outcome: JSON.stringify(outcome) })
      .where(eq(taskPlans.id, id))
      .run();
  }

  /**
   * The latest version with an outcome of each task, newest first, from these orgs (`null` is the
   * local one; undefined is every org) and not from the task `except`.
   */
  recent(orgs: readonly (string | null)[] | undefined, limit: number, except: string): PlanRow[] {
    const latest = sql`${taskPlans.version} = (
      SELECT MAX(q.version) FROM task_plans q WHERE q.task = ${taskPlans.task} AND q.outcome IS NOT NULL)`;
    const filters: (SQL | undefined)[] = [isNotNull(taskPlans.outcome), latest, ne(taskPlans.task, except)];
    if (orgs !== undefined) {
      const named = orgs.filter((o): o is string => o !== null);
      filters.push(
        or(
          named.length > 0 ? inArray(taskPlans.org, named) : undefined,
          orgs.includes(null) ? isNull(taskPlans.org) : undefined,
        ) ?? sql`0`,
      );
    }
    return this.db
      .select()
      .from(taskPlans)
      .where(and(...filters))
      .orderBy(desc(taskPlans.at), desc(taskPlans.id))
      .limit(limit)
      .all()
      .flatMap((r) => parseRow(r) ?? []);
  }
}

const TeamSchema = z.array(PlanMemberSchema);

/** A row whose JSON no longer parses is skipped, so one bad row hides nothing else. */
function parseRow(r: typeof taskPlans.$inferSelect): PlanRow | undefined {
  try {
    const plan = TeamPlanSchema.safeParse(JSON.parse(r.plan));
    const team = TeamSchema.safeParse(JSON.parse(r.team));
    const outcome = r.outcome === null ? undefined : PlanOutcomeSchema.safeParse(JSON.parse(r.outcome));
    if (!plan.success || !team.success || outcome?.success === false) return undefined;
    return {
      id: r.id,
      task: r.task,
      org: r.org,
      version: r.version,
      at: r.at,
      agent: r.agent,
      plan: plan.data,
      team: team.data,
      outcome: outcome?.data ?? null,
    };
  } catch {
    return undefined;
  }
}
