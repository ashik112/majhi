import {
  BUSINESS,
  type Goal,
  type GoalCreateInput,
  GoalSchema,
  type GoalsListInput,
  type GoalUpdateInput,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import { UserError } from "../errors.ts";

/**
 * Goals (SPEC 5.18, "Goals"): what the owner works toward, per workspace or for the whole business.
 * Playbooks and findings point at a goal. The captain may propose one; the owner confirms it.
 */

interface Row {
  id: string;
  org: string;
  title: string;
  metric: string | null;
  target: string | null;
  due: string | null;
  status: string;
  by: string;
  created_at: string;
  updated_at: string;
}

function toGoal(r: Row): Goal {
  return GoalSchema.parse({
    id: r.id,
    org: r.org,
    title: r.title,
    ...(r.metric === null ? {} : { metric: r.metric }),
    ...(r.target === null ? {} : { target: r.target }),
    ...(r.due === null ? {} : { due: r.due }),
    status: r.status,
    by: r.by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

/** Who acts. A captain lane is tied to its workspace. */
export type GoalActor = { kind: "owner" } | { kind: "captain"; org?: string | undefined };

export interface GoalsDeps {
  db: Database.Database;
  now?: () => Date;
  /** Whether a workspace exists. */
  knownOrg(org: string): Promise<boolean>;
  changed?: () => void;
}

function slug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s === "" ? "goal" : s;
}

export class GoalsService {
  constructor(private readonly deps: GoalsDeps) {}

  private at(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  get(id: string): Goal | undefined {
    const row = this.deps.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : toGoal(row);
  }

  /** A captain lane reads its workspace's goals and the business's; the owner reads what they ask for. */
  list(input: GoalsListInput, actor: GoalActor): Goal[] {
    const parts: string[] = [];
    const args: unknown[] = [];
    if (actor.kind === "captain" && actor.org !== undefined) {
      parts.push("org IN (?, ?)");
      args.push(actor.org, BUSINESS);
    } else if (input.org !== undefined) {
      parts.push("org = ?");
      args.push(input.org);
    }
    if (input.status !== undefined) {
      parts.push("status = ?");
      args.push(input.status);
    }
    const where = parts.length === 0 ? "" : `WHERE ${parts.join(" AND ")}`;
    return (
      this.deps.db
        .prepare(
          `SELECT * FROM goals ${where}
           ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, COALESCE(due, '9999'), created_at`,
        )
        .all(...args) as Row[]
    ).map(toGoal);
  }

  async create(input: GoalCreateInput, actor: GoalActor): Promise<Goal> {
    // The captain proposes for its own workspace only: never for the business, never for another workspace.
    let org = input.org;
    if (actor.kind === "captain") {
      if (actor.org === undefined) throw new UserError("Propose a goal from a workspace lane.", 409);
      if (input.org !== actor.org && input.org !== BUSINESS) {
        throw new UserError("A goal belongs to your own workspace.", 409);
      }
      if (input.org === BUSINESS) {
        throw new UserError("Only the owner sets a goal for the whole business.", 409);
      }
      org = actor.org;
    }
    if (org !== BUSINESS && !(await this.deps.knownOrg(org))) {
      throw new UserError(`There is no workspace "${org}".`, 404);
    }
    const at = this.at();
    const base = slug(input.title);
    let id = base;
    for (let n = 2; this.get(id) !== undefined; n++) id = `${base.slice(0, 36)}-${n}`;
    this.deps.db
      .prepare(
        `INSERT INTO goals (id, org, title, metric, target, due, status, by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        org,
        input.title,
        input.metric ?? null,
        input.target ?? null,
        input.due ?? null,
        actor.kind === "owner" ? "active" : "proposed",
        actor.kind,
        at,
        at,
      );
    this.deps.changed?.();
    return this.must(id);
  }

  private must(id: string): Goal {
    const found = this.get(id);
    if (found === undefined) throw new UserError(`There is no goal "${id}".`, 404);
    return found;
  }

  update(input: GoalUpdateInput, actor: GoalActor): Goal {
    const goal = this.must(input.id);
    if (actor.kind === "captain") {
      if (actor.org !== goal.org) throw new UserError("That goal is not in your workspace.", 409);
      // The captain words its own proposal better; it never confirms, finishes or drops a goal.
      if (input.status !== undefined)
        throw new UserError("Only the owner confirms, finishes or drops a goal.", 409);
      if (goal.status !== "proposed")
        throw new UserError("Only the owner changes a goal once it is confirmed.", 409);
    }
    const sets: string[] = ["updated_at = ?"];
    const args: unknown[] = [this.at()];
    const set = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      args.push(value);
    };
    if (input.title !== undefined) set("title", input.title);
    if (input.metric !== undefined) set("metric", input.metric);
    if (input.target !== undefined) set("target", input.target);
    if (input.due !== undefined) set("due", input.due);
    if (input.status !== undefined) set("status", input.status);
    this.deps.db.prepare(`UPDATE goals SET ${sets.join(", ")} WHERE id = ?`).run(...args, input.id);
    this.deps.changed?.();
    return this.must(input.id);
  }

  remove(id: string): void {
    this.must(id);
    this.deps.db.prepare("DELETE FROM goals WHERE id = ?").run(id);
    // Playbooks and findings that pointed at it lose the link.
    this.deps.db.prepare("UPDATE findings SET goal = NULL WHERE goal = ?").run(id);
    const rows = this.deps.db.prepare("SELECT org, playbook, state FROM playbook_state").all() as {
      org: string;
      playbook: string;
      state: string;
    }[];
    for (const r of rows) {
      try {
        const s = JSON.parse(r.state) as { goal?: string | null };
        if (s.goal !== id) continue;
        delete s.goal;
        this.deps.db
          .prepare("UPDATE playbook_state SET state = ? WHERE org = ? AND playbook = ?")
          .run(JSON.stringify(s), r.org, r.playbook);
      } catch {
        // A damaged row has no link to lose.
      }
    }
    this.deps.changed?.();
  }

  /** Whether a goal may be linked to from a workspace: its own or the business's, and not a dropped one. */
  linkable(id: string, org: string): boolean {
    const goal = this.get(id);
    return goal !== undefined && goal.status !== "dropped" && (goal.org === org || goal.org === BUSINESS);
  }
}
