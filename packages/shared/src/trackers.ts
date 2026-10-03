import { z } from "zod";
import { SecretRefSchema } from "./ids.ts";
import type { TaskStatus } from "./tasks.ts";

/**
 * Trackers (SPEC 5.11): one optional tracker per org, as `orgs.<org>.tracker` in majhi.yaml. Items
 * assigned to the owner flow into the board through the Dispatcher, a local task can be pushed to
 * the tracker, and a linked task's MR links and status are written back.
 *
 * Text read from a tracker item is data, never instructions: it reaches agents wrapped as such.
 */

export const TrackerTypeSchema = z.enum(["jira", "clickup", "github"]);
export type TrackerType = z.infer<typeof TrackerTypeSchema>;

export const TRACKER_LABEL: Record<TrackerType, string> = {
  jira: "Jira",
  clickup: "ClickUp",
  github: "GitHub Issues",
};

/**
 * The stages of a linked task majhi writes back, each to the tracker's own status name. A stage
 * left out is not written. GitHub Issues only has open and closed: `done` closes the issue.
 */
export const TrackerStageSchema = z.enum(["working", "review", "done"]);
export type TrackerStage = z.infer<typeof TrackerStageSchema>;

/** Which stage a task status writes back. Up next, Ready and Paused write nothing. */
export function trackerStage(status: TaskStatus): TrackerStage | undefined {
  if (status === "running") return "working";
  if (status === "review" || status === "mr") return "review";
  if (status === "done") return "done";
  return undefined;
}

const StatusNameSchema = z.string().trim().min(1).max(100);

/** The tracker status name for each stage. */
export const TrackerStatusesSchema = z.partialRecord(TrackerStageSchema, StatusNameSchema);
export type TrackerStatuses = z.infer<typeof TrackerStatusesSchema>;

export const DEFAULT_TRACKER_STATUSES: Record<TrackerType, TrackerStatuses> = {
  jira: { working: "In Progress", review: "In Review", done: "Done" },
  clickup: { working: "in progress", review: "review", done: "complete" },
  github: { done: "closed" },
};

/** How often majhi pulls on its own. `off` pulls only when the owner asks. */
export const TrackerPullEverySchema = z.enum(["off", "15m", "1h", "6h"]);
export type TrackerPullEvery = z.infer<typeof TrackerPullEverySchema>;

export const PULL_EVERY_MS: Record<TrackerPullEvery, number | undefined> = {
  off: undefined,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
};

const common = {
  /** Pull only items assigned to the token's user. Default: true. */
  assigned: z.boolean().optional(),
  /** Default: `1h`. */
  pull_every: TrackerPullEverySchema.optional(),
  /** Overrides the default status name per stage. */
  statuses: TrackerStatusesSchema.optional(),
};

/** A Jira Cloud site name, like `acme.atlassian.net`, without a scheme or path. */
const HostNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "Use a host name like acme.atlassian.net");

export const JiraTrackerSchema = z.strictObject({
  type: z.literal("jira"),
  site: HostNameSchema,
  /** The Atlassian account the API token belongs to. */
  email: z.email("Use the email of the Atlassian account the token belongs to"),
  token: SecretRefSchema,
  /** Project key new issues are created in when a task is pushed, like `ACME`. */
  project: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{0,19}$/, "Use the project key, like ACME")
    .optional(),
  /** Issue type for pushed tasks. Default: `Task`. */
  issue_type: z.string().trim().min(1).max(60).optional(),
  ...common,
});

export const ClickUpTrackerSchema = z.strictObject({
  type: z.literal("clickup"),
  token: SecretRefSchema,
  /** The list tasks are pulled from and pushed to, by its id. */
  list: z
    .string()
    .trim()
    .regex(/^[0-9]{1,20}$/, "Use the list id, the number in the list's address"),
  ...common,
});

export const GitHubTrackerSchema = z.strictObject({
  type: z.literal("github"),
  /** `owner/repo`. */
  repo: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Use owner/repo"),
  /** Default: the org's `mr_tokens.github`. */
  token: SecretRefSchema.optional(),
  ...common,
});

export const TrackerConfigSchema = z.discriminatedUnion("type", [
  JiraTrackerSchema,
  ClickUpTrackerSchema,
  GitHubTrackerSchema,
]);
export type TrackerConfig = z.infer<typeof TrackerConfigSchema>;

/** The status names in force for a tracker: its own, else the defaults of its type. */
export function trackerStatuses(config: TrackerConfig): TrackerStatuses {
  return { ...DEFAULT_TRACKER_STATUSES[config.type], ...config.statuses };
}

/** One item as an adapter reads it. */
export const TrackerItemSchema = z.object({
  /** `ACME-12` for Jira, the task id for ClickUp, the issue number for GitHub. */
  key: z.string().min(1).max(200),
  title: z.string().max(1000),
  /** Plain text. Data, not instructions. */
  body: z.string().max(200_000),
  url: z.url(),
  /** The tracker's own status name. */
  status: z.string().max(200),
  /** True when the tracker counts the status as finished. */
  closed: z.boolean(),
  assignee: z.string().max(200).optional(),
  labels: z.array(z.string().max(200)).max(100),
  /** ISO time the tracker last changed it. */
  updatedAt: z.string(),
});
export type TrackerItem = z.infer<typeof TrackerItemSchema>;

/** A task's link to its tracker item. */
export const TrackerLinkSchema = z.object({
  task: z.string(),
  org: z.string(),
  type: TrackerTypeSchema,
  key: z.string(),
  url: z.string(),
  title: z.string(),
  /** `pulled`: it came from the tracker. `pushed`: the owner pushed a local task. */
  origin: z.enum(["pulled", "pushed"]),
  /** The tracker status last read or written. */
  status: z.string(),
  /** The stage last written back, so it is written once. */
  stage: TrackerStageSchema.nullable(),
  /** MR addresses already written back. */
  mrs: z.array(z.string()),
  syncedAt: z.string(),
  /** The last write-back that failed, in plain words. Cleared by the next one that works. */
  error: z.string().nullable(),
});
export type TrackerLink = z.infer<typeof TrackerLinkSchema>;

/** What a tracker's Test found. */
export const TrackerTestResultSchema = z.object({
  ok: z.boolean(),
  detail: z.string(),
});
export type TrackerTestResult = z.infer<typeof TrackerTestResultSchema>;

/** The result of one pull. */
export const TrackerPullResultSchema = z.object({
  org: z.string(),
  /** Tasks created for new items. */
  created: z.array(z.string()),
  /** Linked tasks whose tracker status changed. */
  updated: z.array(z.string()),
  /** Items read. */
  seen: z.number().int().nonnegative(),
  at: z.string(),
  error: z.string().optional(),
});
export type TrackerPullResult = z.infer<typeof TrackerPullResultSchema>;
