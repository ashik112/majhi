import { z } from "zod";
import { IdSchema } from "../ids.ts";
import { TaskIdSchema, type TaskKind, type TaskPriority, type TaskStatus } from "../tasks.ts";

/**
 * Why a ready or inbox task is not running yet, as a typed value (docs/design/task-lifecycle.md,
 * section 5). It is the precursor of the lifecycle design's `blockerOf`: the same name, the same
 * "first gate that fails" rule and the same `gate` discriminator, over the start checks that exist
 * today. Nothing here reads text: every field is a fact a screen can word and act on.
 *
 * Differences from the design, until the scheduler exists: `account` is a gate of its own (a signed-out
 * or limited account is a hold in the design), and `untriaged` and `nobody` are added, since the Home
 * screen has to say something about an inbox task nobody shaped and a task nobody has started.
 */

export const BlockerSchema = z.discriminatedUnion("gate", [
  /** Unmet `depends-on` links: the tasks this one waits for. */
  z.object({ gate: z.literal("dependency"), on: z.array(TaskIdSchema).min(1) }),
  /** The account of its team is signed out, or at its usage limit. */
  z.object({
    gate: z.literal("account"),
    account: IdSchema,
    why: z.enum(["signed-out", "limit"]),
  }),
  /** The owner's computer is too loaded to start more agent work. */
  z.object({ gate: z.literal("machine"), why: z.enum(["memory", "load"]) }),
  /** No free agent slot, overall or on one account. */
  z.object({
    gate: z.literal("slots"),
    scope: z.enum(["total", "account"]),
    account: IdSchema.optional(),
    inUse: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
  }),
  /** The workspace already works on as many tasks as it may at once. */
  z.object({
    gate: z.literal("tasks-at-once"),
    org: z.string(),
    running: z.array(TaskIdSchema),
    max: z.number().int().nonnegative(),
  }),
  /** A budget keeps new work from starting: the day's cap, a workspace's, an account's reserve, the month's ceiling. */
  z.object({
    gate: z.literal("budget"),
    scope: z.enum(["org", "account", "all", "reserve"]),
    scopeId: z.string().optional(),
    period: z.enum(["day", "week", "month"]),
    until: z.string().optional(),
  }),
  /** An inbox task the owner has not shaped yet: what it still lacks. */
  z.object({
    gate: z.literal("untriaged"),
    missing: z.array(z.enum(["priority", "repo"])).min(1),
  }),
  /** Nothing holds it back and nobody has started it. `autopilot`: whether the captain is on and may pick it up. */
  z.object({ gate: z.literal("nobody"), autopilot: z.enum(["on", "off"]) }),
]);
export type Blocker = z.infer<typeof BlockerSchema>;
export type BlockerGate = Blocker["gate"];

/** The order the gates are tried in: the first that fails is the one reason shown. */
export const BLOCKER_ORDER: readonly BlockerGate[] = [
  "untriaged",
  "dependency",
  "account",
  "machine",
  "slots",
  "tasks-at-once",
  "budget",
  "nobody",
];

export interface BlockerTask {
  id: string;
  status: TaskStatus;
  kind: TaskKind;
  org: string;
  priority?: TaskPriority | undefined;
  due?: string | undefined;
  /** How many repos the task changes. */
  repos: number;
  /** Unmet dependencies (`TaskSummary.waitingOn`). */
  waitingOn: readonly string[];
  /** The accounts of the task's team. */
  accounts: readonly string[];
}

interface Room {
  inUse: number;
  limit: number;
  free: number;
}

/** What the world reads like now, as the start checks read it. The server fills it; nothing is stored. */
export interface BlockerWorld {
  autopilot: "on" | "off";
  /** Why the machine is too busy to start more, or undefined. */
  machine: "memory" | "load" | undefined;
  slots: { agents: Room; accounts: ReadonlyMap<string, Room> };
  /** Per workspace: the running tasks that hold a place, and how many may run at once. */
  atOnce: ReadonlyMap<string, { running: readonly string[]; max: number }>;
  /** The account is signed out or at its limit. Accounts that are fine are left out. */
  accountTrouble: ReadonlyMap<string, "signed-out" | "limit">;
  /** The budget holds that cover starts: one per scope. */
  budgets: readonly Extract<Blocker, { gate: "budget" }>[];
}

/** Whether the Home screen files the task under To triage: an inbox task with no priority and no due date. */
export function isUntriaged(task: Pick<BlockerTask, "status" | "priority" | "due">): boolean {
  return task.status === "inbox" && task.priority === undefined && task.due === undefined;
}

/**
 * The first gate that holds a ready or inbox task back, or undefined for any other status. A task
 * with nothing in its way is `nobody`: it waits for someone to start it.
 */
export function blockerOf(task: BlockerTask, world: BlockerWorld): Blocker | undefined {
  if (task.status !== "ready" && task.status !== "inbox") return undefined;
  if (isUntriaged(task)) {
    const missing: ("priority" | "repo")[] = ["priority"];
    if (task.repos === 0 && task.kind === "code") missing.push("repo");
    return { gate: "untriaged", missing };
  }
  if (task.waitingOn.length > 0) return { gate: "dependency", on: [...task.waitingOn] };
  for (const account of task.accounts) {
    const why = world.accountTrouble.get(account);
    if (why !== undefined) return { gate: "account", account, why };
  }
  if (world.machine !== undefined) return { gate: "machine", why: world.machine };
  for (const account of task.accounts) {
    const room = world.slots.accounts.get(account);
    if (room !== undefined && room.free === 0)
      return { gate: "slots", scope: "account", account, inUse: room.inUse, max: room.limit };
  }
  if (world.slots.agents.free === 0)
    return { gate: "slots", scope: "total", inUse: world.slots.agents.inUse, max: world.slots.agents.limit };
  const once = world.atOnce.get(task.org);
  if (once !== undefined && once.running.length >= once.max)
    return { gate: "tasks-at-once", org: task.org, running: [...once.running], max: once.max };
  const budget = world.budgets.find(
    (b) =>
      b.scope === "all" ||
      (b.scope === "org" && b.scopeId === task.org) ||
      ((b.scope === "account" || b.scope === "reserve") &&
        b.scopeId !== undefined &&
        task.accounts.includes(b.scopeId)),
  );
  if (budget !== undefined) return budget;
  return { gate: "nobody", autopilot: world.autopilot };
}
