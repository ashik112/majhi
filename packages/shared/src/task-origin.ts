import { z } from "zod";
import { FindingSeveritySchema, FindingSourceSchema } from "./findings.ts";
import { IdSchema, TaskIdSchema } from "./ids.ts";

/**
 * Where a task came from. The creator sets it once, when the task is made. A reference points at
 * something in the task's own workspace (the server refuses one that does not).
 *
 * `parent` is never stored: a child's parent is its `parent` link, so the link is the one home.
 * `TaskOrigin` is what a reader sees (the link folded in); `StoredOrigin` is what a creator writes.
 */

const owner = z.object({ kind: z.literal("owner") });
const captain = z.object({ kind: z.literal("captain"), reason: z.string().trim().min(1).max(500) });
const finding = z.object({
  kind: z.literal("finding"),
  /** The finding's id. */
  finding: z.number().int().positive(),
  source: FindingSourceSchema,
  severity: FindingSeveritySchema,
});
const watch = z.object({
  kind: z.literal("watch"),
  /** A watch or trigger id. */
  watch: z.string().min(1).max(80),
  incident: z.number().int().positive().optional(),
});
const schedule = z.object({
  kind: z.literal("schedule"),
  /** A schedule (clock playbook) id. */
  schedule: z.string().min(1).max(80),
});
const deploy = z.object({
  kind: z.literal("deploy"),
  /** The deploy record that failed. */
  deploy: z.number().int().positive(),
  project: IdSchema,
  env: z.string().min(1).max(40),
});
const parent = z.object({ kind: z.literal("parent"), task: TaskIdSchema });
const client = z.object({
  kind: z.literal("client"),
  /** The client room (a chat task) the report came in. */
  room: TaskIdSchema,
  /** The room item of the message that reported it. */
  item: z.string().min(1).max(200),
});

export const StoredOriginSchema = z.discriminatedUnion("kind", [
  owner,
  captain,
  finding,
  watch,
  schedule,
  deploy,
  client,
]);
export type StoredOrigin = z.infer<typeof StoredOriginSchema>;

export const TaskOriginSchema = z.discriminatedUnion("kind", [
  owner,
  captain,
  finding,
  watch,
  schedule,
  deploy,
  client,
  parent,
]);
export type TaskOrigin = z.infer<typeof TaskOriginSchema>;
export type OriginKind = TaskOrigin["kind"];

/**
 * An origin with the name to show for it: a finding's source, a parent's title, a watch's or
 * schedule's name. `name` is absent when the thing is gone or the origin has nothing to name.
 */
export const OriginViewSchema = z.discriminatedUnion("kind", [
  owner.extend({ name: z.string().optional() }),
  captain.extend({ name: z.string().optional() }),
  finding.extend({ name: z.string().optional() }),
  watch.extend({ name: z.string().optional() }),
  schedule.extend({ name: z.string().optional() }),
  deploy.extend({ name: z.string().optional() }),
  /** `name`: the room's title. `from`: the line the task shows, like "Telegram · Acme ops · Sara". */
  client.extend({ name: z.string().optional(), from: z.string().optional() }),
  parent.extend({ name: z.string().optional() }),
]);
export type OriginView = z.infer<typeof OriginViewSchema>;

/**
 * What a reader sees as a task's origin: the one its creator stored, else its parent when it is a
 * child, else nothing (a task made before origins). `links` are the task's own links; a `parent`
 * link names the parent in `task`.
 */
export function originOf(
  stored: StoredOrigin | undefined,
  links: readonly { type: string; task: string }[],
): TaskOrigin | undefined {
  if (stored !== undefined) return stored;
  const link = links.find((l) => l.type === "parent");
  return link === undefined ? undefined : { kind: "parent", task: link.task };
}
