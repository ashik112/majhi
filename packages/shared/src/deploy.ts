import { z } from "zod";
import { IdSchema, LocalBranchSchema, TaskIdSchema } from "./ids.ts";
import type { ShipStep } from "./ship-rules.ts";

/**
 * Environments, deploy records and what a deploy shows (docs/briefs/deploy-v2.md).
 *
 * One source of truth. An environment lives in the project's config, next to its base branch and remotes.
 * A deploy record is one row of one table: planned by the captain (`projects.planDeploy`), run by
 * `projects.deploy`. Everything else (a task's deploy steps in its trail, who deploys what) is derived on read.
 * How a project deploys (jobs, inputs, order, quirks) is prose in the project's wiki, not a form.
 *
 * Nothing here carries a secret. A run on a git host names one of the project's remotes and uses the
 * workspace's git account for that host; vercel and ssh runs name a workspace connection.
 */

/** An environment name: `staging`, `production`, or one the owner picks. One `/` is allowed (`app/acme`). */
export const EnvNameSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,39}(?:\/[a-z0-9][a-z0-9-]{0,39})?$/,
    "Use lowercase letters, digits and dashes, starting with a letter or digit, with at most one /",
  );

/** Who decides an environment: the Deploy production cell for `production`, the Deploy staging cell for `staging`. */
export const DeployTierSchema = z.enum(["production", "staging"]);
export type DeployTier = z.infer<typeof DeployTierSchema>;

/** Which ship step decides who deploys an environment: by its tier, never by its name. */
export function deployStepOf(tier: DeployTier): Extract<ShipStep, "deployStaging" | "deployProduction"> {
  return tier === "staging" ? "deployStaging" : "deployProduction";
}

/**
 * One environment of a project. `branch`: pushing or merging to it deploys (the host's CI does it).
 * `check`: answers 2xx when the environment is up. A tier that is not named is production.
 */
export const DeployEnvironmentSchema = z.object({
  env: EnvNameSchema,
  tier: DeployTierSchema.default("production"),
  branch: LocalBranchSchema.optional(),
  check: z
    .url({ protocol: /^https?$/ })
    .max(500)
    .optional(),
});
export type DeployEnvironment = z.infer<typeof DeployEnvironmentSchema>;

/**
 * Environments written before deploys v2 were targets with a route, a check and a rollback. The name and the
 * health address carry over; the tier is production unless the name is exactly `staging`. Anything else is dropped.
 */
function fromTargets(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item: unknown) => {
    if (typeof item !== "object" || item === null) return item;
    const old = item as { env?: unknown; via?: unknown; verify?: unknown; rollback?: unknown };
    if (old.via === undefined && old.verify === undefined && old.rollback === undefined) return item;
    const verify = old.verify;
    const health =
      typeof verify === "object" && verify !== null ? (verify as { health?: unknown }).health : undefined;
    return {
      env: old.env,
      tier: old.env === "staging" ? "staging" : "production",
      ...(typeof health === "string" ? { check: health } : {}),
    };
  });
}

/** A list of environments, each listed once. */
export const DeployEnvironmentListSchema = z
  .array(DeployEnvironmentSchema)
  .max(20)
  .refine((list) => new Set(list.map((e) => e.env)).size === list.length, {
    message: "Each environment is listed once",
  });

/** A project's environments, in the order they usually go live. Reads the older target form too. */
export const DeployEnvironmentsSchema = z.preprocess(fromTargets, DeployEnvironmentListSchema);

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

/** A git remote of the project, by name (`origin`). Its host gives the provider; the workspace's git account for it gives the token. */
const RemoteNameSchema = z.string().trim().min(1).max(100);

/**
 * One run on a host. A step has up to 8, in the order they must go (a build, then the deploy job).
 * A run is repeatable when the host can start it again for an earlier commit: that is what a rollback does.
 */
export const DeployRunStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("github-workflow"),
    remote: RemoteNameSchema,
    /** The workflow file in `.github/workflows`, like `deploy.yml`. */
    workflow: FileName,
    ref: z.union([z.literal("base"), RefSchema]).default("base"),
    inputs: InputsSchema.optional(),
  }),
  z.object({
    kind: z.literal("gitlab-job"),
    remote: RemoteNameSchema,
    /** A manual job of the commit's pipeline. The pipeline is created when the commit has none. */
    job: z.string().trim().min(1).max(200),
    variables: InputsSchema.optional(),
  }),
  z.object({
    kind: z.literal("gitlab-pipeline"),
    remote: RemoteNameSchema,
    ref: z.union([z.literal("base"), RefSchema]).default("base"),
    variables: InputsSchema.optional(),
  }),
  z.object({
    kind: z.literal("bitbucket-pipeline"),
    remote: RemoteNameSchema,
    /** A custom pipeline of the project, the name under `pipelines: custom:` in `bitbucket-pipelines.yml`. */
    pipeline: z.string().trim().min(1).max(200),
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
    /** A command the owner wrote. Never planned by the captain, never built from task text. */
    command: z.string().trim().min(1).max(2000),
  }),
]);
export type DeployRunStep = z.infer<typeof DeployRunStepSchema>;
export type DeployKind = DeployRunStep["kind"];

export const DeployRunsSchema = z.array(DeployRunStepSchema).min(1).max(8);

export const DEPLOY_KIND_LABEL: Record<DeployKind, string> = {
  "github-workflow": "GitHub workflow",
  "gitlab-job": "GitLab job",
  "gitlab-pipeline": "GitLab pipeline",
  "bitbucket-pipeline": "Bitbucket pipeline",
  vercel: "Vercel",
  ssh: "SSH command",
};

/** One run in a line, for a row and a log: "GitHub workflow deploy.yml", "GitLab job deploy-prod", "Bitbucket pipeline deploy-prod". */
export function deployRunLine(run: DeployRunStep): string {
  switch (run.kind) {
    case "github-workflow":
      return `${DEPLOY_KIND_LABEL[run.kind]} ${run.workflow}`;
    case "gitlab-job":
      return `${DEPLOY_KIND_LABEL[run.kind]} ${run.job}`;
    case "gitlab-pipeline":
      return DEPLOY_KIND_LABEL[run.kind];
    case "bitbucket-pipeline":
      return `${DEPLOY_KIND_LABEL[run.kind]} ${run.pipeline}`;
    case "vercel":
      return `Vercel ${run.project}`;
    case "ssh":
      return DEPLOY_KIND_LABEL[run.kind];
  }
}

// ---------------------------------------------------------------------------
// Records

/**
 * A deploy's states. `planned`: the captain's plan names it, nothing decided yet (a plan that is replaced deletes
 * its own planned rows). `held`: the owner said hold, or the plan holds it for a reason, so no rule deploys it.
 * `queued`: decided, not started. `running`: the run is going. `verifying`: the run ended well and
 * the check is waiting. `live`: the check passed. `failed`: the run or the check failed. `rolled-back`:
 * the target went back to the commit it ran before.
 */
export const DEPLOY_STATES = [
  "planned",
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
  planned: ["queued", "held"],
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

/**
 * The run a provider started for one of a record's runs: its id, its page, and for GitHub which attempt of it
 * is ours. `ended` once the run ended well, so a restart goes on with the next one and never starts one twice.
 */
export const DeployRunSchema = z.object({
  id: z.string().min(1).max(200),
  url: z.string().max(500).optional(),
  attempt: z.number().int().positive().optional(),
  ended: z.boolean().optional(),
});
export type DeployRun = z.infer<typeof DeployRunSchema>;

/**
 * A planned or plan-held record has no commit yet: it is the head of the base branch when the record runs. Until
 * then `commit` holds this stand-in, which is unique per task and step. Never shown as a commit.
 */
export function plannedCommit(task: string, seq: number): string {
  return `planned-${task}-${seq}`;
}

/** Whether a record's `commit` is a real commit and not the stand-in of a step that has not run. */
export function deployHasCommit(record: Pick<DeployRecord, "commit">): boolean {
  return !record.commit.startsWith("planned-");
}

export const DeployRecordSchema = z.object({
  id: z.number().int().positive(),
  org: IdSchema,
  project: IdSchema,
  env: EnvNameSchema,
  /** The commit deployed, in full. A step that has not run yet holds a stand-in: see `deployHasCommit`. */
  commit: z.string().min(7).max(64),
  /** The commit the target ran before: where a rollback goes. Absent for the first deploy. */
  previous: z.string().min(7).max(64).optional(),
  state: DeployStateSchema,
  /** The task whose merge this ships. Absent for a deploy the owner started from the project page. */
  task: TaskIdSchema.optional(),
  by: DeployByIdSchema,
  /** What to run, in order: 1 to 8 runs. Records from before deploys v2 have none and cannot be repeated. */
  runs: z.array(DeployRunStepSchema).max(8).default([]),
  /** The provider's run for each of `runs` started so far, in the same order. */
  handles: z.array(DeployRunSchema).max(8).default([]),
  /** The newest of `handles`: the run to show. Derived on read. */
  run: DeployRunSchema.optional(),
  /** The step's place in its task's plan: a step waits for the ones before it. 0 for a deploy outside a plan. */
  seq: z.number().int().nonnegative().default(0),
  /** Why the captain planned it, or what it skips, in a sentence. Display only. */
  note: z.string().max(500).optional(),
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
    case "planned":
    case "captain-next":
    case "waits-for-previous":
      return "idle";
  }
}

/** The state in a word or two, for a chip and its title. */
export const DEPLOY_STATE_WORD: Record<DeployStepState, string> = {
  none: "not set up",
  planned: "planned",
  "captain-next": "next",
  "waits-for-owner": "waits for you",
  "waits-for-previous": "waiting",
  blocked: "cannot run yet",
  held: "held",
  queued: "queued",
  running: "deploying",
  verifying: "checking",
  live: "live",
  failed: "failed",
  "rolled-back": "rolled back",
};

/** How one run of a step reads: waiting its turn, going now, done, or the one that failed. */
export type DeployRunState = "waiting" | "running" | "done" | "failed";

/** The state of each of a record's runs, in order. Derived from the handles and the record's state. */
export function deployRunStates(r: Pick<DeployRecord, "runs" | "handles" | "state">): DeployRunState[] {
  const live = r.state === "live" || r.state === "verifying";
  const dead = r.state === "failed" || r.state === "rolled-back";
  let current = r.runs.findIndex((_, i) => r.handles[i]?.ended !== true);
  if (current < 0) current = r.runs.length;
  return r.runs.map((_, i): DeployRunState => {
    if (live || i < current) return "done";
    if (i > current) return "waiting";
    if (dead) return "failed";
    return r.state === "running" ? "running" : "waiting";
  });
}

export const DeployStepViewSchema = z.object({
  project: IdSchema,
  env: EnvNameSchema,
  /** The environment's tier, when the project still has it. */
  tier: DeployTierSchema.optional(),
  state: DeployStepStateSchema,
  /** Who does the step by the ship rules. */
  who: z.enum(["captain", "owner"]),
  /** Absent while the step has not run: it deploys the head of the base branch when it does. */
  commit: z.string().optional(),
  record: z.number().int().positive().optional(),
  /** The step's place in its task's plan. */
  seq: z.number().int().nonnegative().optional(),
  /** What to run, and how far it got. */
  runs: z.array(DeployRunStepSchema).max(8).optional(),
  runStates: z
    .array(z.enum(["waiting", "running", "done", "failed"]))
    .max(8)
    .optional(),
  /** Why the captain planned it, or what it skips. */
  note: z.string().optional(),
  /** The run's page, once there is one. */
  run: z.string().optional(),
  /** What blocks it or why it failed, in a sentence. */
  why: z.string().optional(),
  /** The incident task a failure opened. */
  incident: TaskIdSchema.optional(),
});
export type DeployStepView = z.infer<typeof DeployStepViewSchema>;

/** A record as a step of a task's deploys: what the row says, nothing decided. */
export function deployStepOfRecord(r: DeployRecord, tier?: DeployTier): DeployStepView {
  return {
    project: r.project,
    env: r.env,
    ...(tier === undefined ? {} : { tier }),
    state: r.state,
    who: r.by,
    ...(deployHasCommit(r) ? { commit: r.commit } : {}),
    record: r.id,
    seq: r.seq,
    ...(r.runs.length === 0 ? {} : { runs: r.runs, runStates: deployRunStates(r) }),
    ...(r.note === undefined ? {} : { note: r.note }),
    ...(r.run?.url === undefined ? {} : { run: r.run.url }),
    ...(r.reason === undefined ? {} : { why: r.reason }),
    ...(r.incident === undefined ? {} : { incident: r.incident }),
  };
}

/**
 * Where a task with deploy steps sits on the board. `asks`: a deploy waits for the owner. `failed`: a deploy
 * failed or was rolled back. `moving`: something is going out or is next. `done`: every environment is live, or
 * held by the owner. Pure, so the board and the tests read it one way.
 */
export type DeployPhase = "asks" | "failed" | "moving" | "done";

export function deployPhase(steps: readonly Pick<DeployStepView, "state">[]): DeployPhase {
  const has = (...states: DeployStepState[]) => steps.some((s) => states.includes(s.state));
  if (has("failed", "rolled-back")) return "failed";
  if (has("waits-for-owner")) return "asks";
  if (
    has("planned", "queued", "running", "verifying", "captain-next", "waits-for-previous", "blocked", "none")
  ) {
    return "moving";
  }
  return "done";
}

/** What the board reads about the deploys of one recently merged task. */
export const HomeDeploySchema = z.object({
  task: TaskIdSchema,
  steps: z.array(DeployStepViewSchema),
});
export type HomeDeploy = z.infer<typeof HomeDeploySchema>;

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
// Commands

export const ProjectDeployViewSchema = z.object({
  project: IdSchema,
  environments: z.array(DeployEnvironmentSchema),
  /** Newest first. */
  history: z.array(DeployRecordSchema),
  /** The deploys whose rollback is running now. */
  rollingBack: z.array(z.number().int().positive()).default([]),
  /** The ship rule that covers the project's deploys, in words, when the owner set one. */
  rule: z.string().optional(),
});
export type ProjectDeployView = z.infer<typeof ProjectDeployViewSchema>;

/**
 * `projects.deploy`: runs a planned (or held, or failed) record by id, or, for the owner, an ad-hoc deploy of
 * the base branch head to one environment with the runs written here.
 */
export const DeployInputSchema = z.union([
  z.object({
    record: z.number().int().positive(),
    /** Owner only: deploy a head no merge of majhi's produced, past the check. */
    confirmUnchecked: z.boolean().optional(),
    /** Owner only: try again a deploy that failed or was rolled back. */
    retry: z.boolean().optional(),
  }),
  z.object({
    project: IdSchema,
    env: EnvNameSchema,
    runs: DeployRunsSchema,
    /** Default: the project's base branch tip. */
    commit: z.string().trim().min(7).max(64).optional(),
    /** The task whose merge this ships. */
    task: TaskIdSchema.optional(),
    confirmUnchecked: z.boolean().optional(),
    retry: z.boolean().optional(),
  }),
]);
export type DeployInput = z.infer<typeof DeployInputSchema>;

/** What `projects.deploy` and `projects.rollback` answer: the record, and whether this call changed anything. */
export const DeployResultSchema = z.object({
  record: DeployRecordSchema,
  /** The same environment and commit was already deploying or live: nothing new started. */
  repeat: z.boolean(),
});
export type DeployResult = z.infer<typeof DeployResultSchema>;

export const RollbackInputSchema = z.object({ record: z.number().int().positive() });

/** Holds a planned record by id, or a commit of an environment that has no record yet. */
export const DeployHoldInputSchema = z.union([
  z.object({ record: z.number().int().positive() }),
  z.object({
    project: IdSchema,
    env: EnvNameSchema,
    commit: z.string().trim().min(7).max(64),
    task: TaskIdSchema.optional(),
    runs: DeployRunsSchema.optional(),
  }),
]);

export const DeployViewInputSchema = z.object({ project: IdSchema });

/** `projects.setEnvironments`: the whole list of a project's environments. An empty list removes them. */
export const SetEnvironmentsInputSchema = z.object({
  project: IdSchema,
  environments: DeployEnvironmentListSchema,
});

/** One step of a task's deploy plan. `hold`: the step waits for the owner, and says why. */
export const DeployPlanStepSchema = z.object({
  project: IdSchema,
  env: EnvNameSchema,
  runs: DeployRunsSchema,
  hold: z.literal("migration").optional(),
  note: z.string().trim().max(500).optional(),
});
export type DeployPlanStep = z.infer<typeof DeployPlanStepSchema>;

/** `projects.planDeploy`: the plan of one task. It replaces the task's planned rows. Steps go in this order. */
export const PlanDeployInputSchema = z.object({
  task: TaskIdSchema,
  steps: z.array(DeployPlanStepSchema).max(20),
});
export type PlanDeployInput = z.infer<typeof PlanDeployInputSchema>;

export const PlanDeployResultSchema = z.object({ records: z.array(DeployRecordSchema) });
export type PlanDeployResult = z.infer<typeof PlanDeployResultSchema>;
