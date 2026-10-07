import { z } from "zod";
import { IdSchema, TaskIdSchema } from "./ids.ts";
import type { ShipStep } from "./ship-rules.ts";

/**
 * Deploy targets, deploy records and what a deploy shows (docs/design/ship-without-me.md, section 3).
 *
 * One source of truth. A target lives in the project's config, next to its base branch and remotes.
 * A deploy record is one row of one table, written by `projects.deploy`. Everything else (a task's
 * deploy steps in its trail, the suggestions, who deploys what) is derived on read.
 *
 * Nothing here carries a secret. A target names a workspace connection, and majhi reads the
 * credential from it only while it triggers a run.
 */

/** A watch id, as `watches.ts` spells it (not imported: that file reads the project config, which holds a target). */
const WatchRefSchema = z.string().regex(/^wch-[a-z0-9]{4,12}$/);

/** An environment name: `staging`, `production`, or one the owner picks. */
export const EnvNameSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,39}$/,
    "Use lowercase letters, digits and dashes, starting with a letter or digit",
  );

/**
 * Which ship step decides who deploys an environment. The ship rules have two Deploy cells: the
 * environment named `production` uses Deploy production, every other one uses Deploy staging.
 */
export function deployStepOf(env: string): Extract<ShipStep, "deployStaging" | "deployProduction"> {
  return env === "production" ? "deployProduction" : "deployStaging";
}

const FileName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((v) => !v.includes("/") && !v.includes("\\") && !v.includes("\0"), "A file name, without a folder");

/** A branch or tag the run starts from. `base` is the project's base branch. */
const RefSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((v) => !v.includes("..") && !v.includes("\0") && !v.startsWith("-"), "Not a branch name");

const InputsSchema = z.record(z.string().trim().min(1).max(100), z.string().max(500));

/** How the target is deployed. Every kind names a connection of the project's own workspace. */
export const DeployViaSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("github-workflow"),
    /** A `git` connection of the project's workspace, for GitHub. */
    connection: IdSchema,
    /** The workflow file in `.github/workflows`, like `deploy.yml`. */
    workflow: FileName,
    ref: z.union([z.literal("base"), RefSchema]).default("base"),
    inputs: InputsSchema.optional(),
  }),
  z.object({
    kind: z.literal("gitlab-pipeline"),
    /** A `git` connection of the project's workspace, for GitLab. */
    connection: IdSchema,
    ref: z.union([z.literal("base"), RefSchema]).default("base"),
    variables: InputsSchema.optional(),
  }),
  z.object({
    kind: z.literal("vercel"),
    /** An `env` connection of the project's workspace that holds `VERCEL_TOKEN`. */
    connection: IdSchema,
    /** The Vercel project name. */
    project: z.string().trim().min(1).max(100),
    target: z.enum(["preview", "production"]),
  }),
  z.object({
    kind: z.literal("ssh"),
    /** An `ssh` connection of the project's workspace. */
    connection: IdSchema,
    /** A command the owner wrote. majhi never builds one from task text. */
    command: z.string().trim().min(1).max(2000),
  }),
]);
export type DeployVia = z.infer<typeof DeployViaSchema>;
export type DeployKind = DeployVia["kind"];

export const DEPLOY_KIND_LABEL: Record<DeployKind, string> = {
  "github-workflow": "GitHub workflow",
  "gitlab-pipeline": "GitLab pipeline",
  vercel: "Vercel",
  ssh: "SSH command",
};

/** How a deploy is checked once the run ends: the URL answers 2xx, and the watch stays green, for the wait. */
export const DeployVerifySchema = z
  .object({
    /** A URL that answers 2xx when the new version is up. */
    health: z.httpUrl().max(500).optional(),
    /** A watch of the same workspace that must read ok for the wait. */
    watch: WatchRefSchema.optional(),
    waitSeconds: z.number().int().min(0).max(1800).default(60),
  })
  .refine((v) => v.health !== undefined || v.watch !== undefined, {
    message: "Name a health address or a watch, so a deploy can be checked",
  });
export type DeployVerify = z.infer<typeof DeployVerifySchema>;

export const DeployRollbackSchema = z.discriminatedUnion("kind", [
  /** Run the same deploy again for the commit that was live before. */
  z.object({ kind: z.literal("redeploy-previous") }),
  z.object({
    kind: z.literal("ssh"),
    connection: IdSchema,
    /** A command the owner wrote. The commit it goes back to is not put in it. */
    command: z.string().trim().min(1).max(2000),
  }),
]);
export type DeployRollback = z.infer<typeof DeployRollbackSchema>;

export const DeployTargetSchema = z.object({
  env: EnvNameSchema,
  via: DeployViaSchema,
  verify: DeployVerifySchema,
  rollback: DeployRollbackSchema,
});
export type DeployTarget = z.infer<typeof DeployTargetSchema>;

/** A project's targets, in the order they must go live: a target waits for the ones before it. */
export const DeployTargetsSchema = z
  .array(DeployTargetSchema)
  .max(10)
  .refine((targets) => new Set(targets.map((t) => t.env)).size === targets.length, {
    message: "Each environment is listed once",
  });

/** The one-line form of a target's route, for rows and logs: "GitHub workflow deploy.yml". */
export function viaLine(via: DeployVia): string {
  switch (via.kind) {
    case "github-workflow":
      return `${DEPLOY_KIND_LABEL[via.kind]} ${via.workflow}`;
    case "gitlab-pipeline":
      return DEPLOY_KIND_LABEL[via.kind];
    case "vercel":
      return `Vercel ${via.project}`;
    case "ssh":
      return `${DEPLOY_KIND_LABEL[via.kind]} on ${via.connection}`;
  }
}

// ---------------------------------------------------------------------------
// Records

/**
 * A deploy's states. `held`: the owner said hold, so no rule deploys this commit to this target.
 * `queued`: decided, not started. `running`: the run is going. `verifying`: the run ended well and
 * the check is waiting. `live`: the check passed. `failed`: the run or the check failed. `rolled-back`:
 * the target went back to the commit it ran before.
 */
export const DEPLOY_STATES = [
  "held",
  "queued",
  "running",
  "verifying",
  "live",
  "failed",
  "rolled-back",
] as const;
export const DeployStateSchema = z.enum(DEPLOY_STATES);
export type DeployState = z.infer<typeof DeployStateSchema>;

/** The moves a record may make. Anything else is a bug, so the store refuses it. */
export const DEPLOY_MOVES: Readonly<Record<DeployState, readonly DeployState[]>> = {
  held: ["queued"],
  queued: ["running", "failed", "held"],
  running: ["verifying", "failed"],
  verifying: ["live", "failed"],
  live: ["rolled-back"],
  failed: ["rolled-back", "queued"],
  "rolled-back": ["queued"],
};

export function deployMayMove(from: DeployState, to: DeployState): boolean {
  return DEPLOY_MOVES[from].includes(to);
}

/** Still moving: a second request for the same target and commit joins it. */
export function deployIsActive(state: DeployState): boolean {
  return state === "queued" || state === "running" || state === "verifying";
}

export const DeployByIdSchema = z.enum(["owner", "captain"]);

/** The run a provider started: its id, its page, and for GitHub which attempt of it is ours. */
export const DeployRunSchema = z.object({
  id: z.string().min(1).max(200),
  url: z.string().max(500).optional(),
  attempt: z.number().int().positive().optional(),
});
export type DeployRun = z.infer<typeof DeployRunSchema>;

export const DeployRecordSchema = z.object({
  id: z.number().int().positive(),
  org: IdSchema,
  project: IdSchema,
  env: EnvNameSchema,
  /** The commit deployed, in full. */
  commit: z.string().min(7).max(64),
  /** The commit the target ran before: where a rollback goes. Absent for the first deploy. */
  previous: z.string().min(7).max(64).optional(),
  state: DeployStateSchema,
  /** The task whose merge this ships. Absent for a deploy the owner started from the project page. */
  task: TaskIdSchema.optional(),
  by: DeployByIdSchema,
  /** The run the provider started: its id and its page. */
  run: DeployRunSchema.optional(),
  /** What the check found. */
  check: z.object({ ok: z.boolean(), detail: z.string(), at: z.string() }).optional(),
  /** Why it failed or was held, in a sentence. Display only. */
  reason: z.string().optional(),
  /** The rollback, once there was one. */
  rollback: z
    .object({
      ok: z.boolean(),
      detail: z.string(),
      /** The commit the target went back to. */
      commit: z.string().optional(),
      run: DeployRunSchema.optional(),
      at: z.string(),
    })
    .optional(),
  /** The incident task a failure opened. */
  incident: TaskIdSchema.optional(),
  /** The owner deployed a commit no task of majhi merged, past the check. Never the captain. */
  unchecked: z.boolean().optional(),
  attempt: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().optional(),
});
export type DeployRecord = z.infer<typeof DeployRecordSchema>;

// ---------------------------------------------------------------------------
// What a task's deploys look like

/**
 * One deploy step of a task, read now: a target of a project the task changed, with what happens to
 * it. `next` is who moves it on: the captain by the ship rules, or the owner. Derived, never stored.
 */
export const DeployStepStateSchema = z.enum([
  "none",
  "captain-next",
  "waits-for-owner",
  "waits-for-previous",
  "blocked",
  ...DEPLOY_STATES,
]);
export type DeployStepState = z.infer<typeof DeployStepStateSchema>;

/** How a deploy step reads on a trail: the owner has to act, something moves, it is held, nothing moves it yet, or it finished. */
export function deployTone(state: DeployStepState): "done" | "working" | "needs" | "paused" | "idle" {
  switch (state) {
    case "live":
      return "done";
    case "queued":
    case "running":
    case "verifying":
      return "working";
    case "waits-for-owner":
    case "failed":
    case "rolled-back":
      return "needs";
    case "held":
    case "blocked":
      return "paused";
    case "none":
    case "captain-next":
    case "waits-for-previous":
      return "idle";
  }
}

/** The state in a word or two, for a chip and its title. */
export const DEPLOY_STATE_WORD: Record<DeployStepState, string> = {
  none: "not set up",
  "captain-next": "next",
  "waits-for-owner": "waits for you",
  "waits-for-previous": "after the one before",
  blocked: "blocked",
  held: "held",
  queued: "queued",
  running: "deploying",
  verifying: "checking",
  live: "live",
  failed: "failed",
  "rolled-back": "rolled back",
};

export const DeployStepViewSchema = z.object({
  project: IdSchema,
  env: EnvNameSchema,
  state: DeployStepStateSchema,
  /** Who does the step by the ship rules. */
  who: z.enum(["captain", "owner"]),
  commit: z.string().optional(),
  record: z.number().int().positive().optional(),
  /** The run's page, once there is one. */
  run: z.string().optional(),
  /** What blocks it or why it failed, in a sentence. */
  why: z.string().optional(),
});
export type DeployStepView = z.infer<typeof DeployStepViewSchema>;

/** A record as a step of a task's deploys: what the row says, nothing decided. */
export function deployStepOfRecord(r: DeployRecord): DeployStepView {
  return {
    project: r.project,
    env: r.env,
    state: r.state,
    who: r.by,
    commit: r.commit,
    record: r.id,
    ...(r.run?.url === undefined ? {} : { run: r.run.url }),
    ...(r.reason === undefined ? {} : { why: r.reason }),
  };
}

/**
 * The question the task page asks when a deploy waits for the owner: "Deploy to production? Staging is healthy
 * at a1b2c3d. The fix is 38 lines." Read now from the steps and the record of the environment before it.
 */
export const DeployAskSchema = z.object({
  project: IdSchema,
  env: EnvNameSchema,
  commit: z.string(),
  /** The environment before this one, when it is live at the commit. */
  after: EnvNameSchema.optional(),
  /** The size of the change, when the diff can say. */
  lines: z.number().int().nonnegative().optional(),
});
export type DeployAsk = z.infer<typeof DeployAskSchema>;

// ---------------------------------------------------------------------------
// Suggestions

/**
 * A target majhi found in the project, offered to the owner. Derived on every read from the repo's files and
 * the workspace's connections; never copied into the project card or the wiki. `target` is set when nothing
 * is left to write, so one click saves it. Otherwise the form opens with what is known.
 */
export const DeploySuggestionSchema = z.object({
  /** Stable for the same finding, so a hidden suggestion stays hidden. */
  id: z.string().min(1).max(200),
  env: EnvNameSchema,
  kind: z.enum(["github-workflow", "gitlab-pipeline", "vercel", "ssh"]),
  /** What it was found in: ".github/workflows/deploy.yml". */
  found: z.string(),
  /** In words: "has workflow_dispatch". */
  because: z.string(),
  /** The workspace's connection that fits, when there is one. */
  connection: IdSchema.optional(),
  workflow: z.string().optional(),
  project: z.string().optional(),
  /** A watch of the workspace that looks at the same address, offered as the check. */
  watch: z.string().optional(),
  /** What is missing for a one-click target, in a few words: "A health address". */
  needs: z.string().optional(),
  target: DeployTargetSchema.optional(),
});
export type DeploySuggestion = z.infer<typeof DeploySuggestionSchema>;

// ---------------------------------------------------------------------------
// Commands

export const ProjectDeployViewSchema = z.object({
  project: IdSchema,
  targets: z.array(DeployTargetSchema),
  suggestions: z.array(DeploySuggestionSchema),
  /** Newest first. */
  history: z.array(DeployRecordSchema),
  /** The ship rule that covers the project's deploys, in words, when the owner set one. */
  rule: z.string().optional(),
});
export type ProjectDeployView = z.infer<typeof ProjectDeployViewSchema>;

export const DeployInputSchema = z.object({
  project: IdSchema,
  env: EnvNameSchema,
  /** Default: the project's base branch tip. */
  commit: z.string().trim().min(7).max(64).optional(),
  /** The task whose merge this ships. */
  task: TaskIdSchema.optional(),
  /** Owner only: deploy a base tip no merge of majhi's produced, past the check. */
  confirmUnchecked: z.boolean().optional(),
  /** Owner only: try again a deploy that failed or was rolled back. */
  retry: z.boolean().optional(),
});
export type DeployInput = z.infer<typeof DeployInputSchema>;

/** What `projects.deploy` and `projects.rollback` answer: the record, and whether this call changed anything. */
export const DeployResultSchema = z.object({
  record: DeployRecordSchema,
  /** The same target and commit was already deploying or live: nothing new started. */
  repeat: z.boolean(),
});
export type DeployResult = z.infer<typeof DeployResultSchema>;

export const RollbackInputSchema = z.object({ record: z.number().int().positive() });

export const DeployHoldInputSchema = z.object({
  project: IdSchema,
  env: EnvNameSchema,
  commit: z.string().trim().min(7).max(64),
  task: TaskIdSchema.optional(),
});

export const DeployViewInputSchema = z.object({ project: IdSchema });
export const DeployHideInputSchema = z.object({ project: IdSchema, suggestion: z.string().min(1).max(200) });

/** The target the owner confirmed: a suggestion by id, or one written by hand. Saved in the project's config. */
export const DeploySetInputSchema = z.object({ project: IdSchema, target: DeployTargetSchema });
export const DeployRemoveInputSchema = z.object({ project: IdSchema, env: EnvNameSchema });
