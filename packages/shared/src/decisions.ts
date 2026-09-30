import { z } from "zod";
import { IdSchema } from "./accounts.ts";
import { TaskIdSchema } from "./tasks.ts";
import { DEFAULT_TIERS, RoleSchema, resolveTier, type Tiers, TiersPatchSchema } from "./tiers.ts";

/**
 * The decision provider (SPEC 5.12): typed questions answered in one pass,
 * with probabilities and a confidence, by Laya, Jev, an ACP agent standing in
 * for them, or plain rules, in a fallback chain.
 */

export const ProviderIdSchema = z.enum(["laya", "jev", "acp", "rules"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

/** At most 20 options per question (Laya gets worse past that). */
export const MAX_OPTIONS = 20;

/**
 * One option of a choice: the key the answer names, and what it means. Laya reads it as
 * `key: description`. Use meaningful keys (`small`, `large`) or neutral ones (`A`, `B`) with a
 * description, never yes or no words.
 */
export const OptionSchema = z.object({
  key: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(200).optional(),
});
export type Option = z.infer<typeof OptionSchema>;

/** The option majhi adds to a choice unless `abstain` is false. An answer naming it never counts. */
export const ABSTAIN: Readonly<{ key: string; description: string }> = {
  key: "none",
  description: "none of these fits",
};

/**
 * How a choice is asked, for providers whose answer depends on the order of the options (Laya):
 * `once`; `reversed`, as given and reversed; `shifted`, in up to 6 cyclic shifts. The probabilities
 * are averaged over the runs. The abstain option stays last.
 */
export const OrderRunsSchema = z.enum(["once", "reversed", "shifted"]);
export type OrderRuns = z.infer<typeof OrderRunsSchema>;

const Described = z.string().trim().min(1).max(200);

export const QuestionSchema = z.discriminatedUnion("type", [
  /** Pick one of `options`. A plain string is an option with no description, and its own key. */
  z
    .object({
      type: z.literal("choice"),
      instructions: z.string().trim().min(1).max(500),
      options: z
        .array(z.union([z.string().trim().min(1).max(200), OptionSchema]))
        .min(2)
        .max(MAX_OPTIONS)
        .refine((list) => new Set(list.map(optionKey)).size === list.length, "Option keys must be unique"),
      /** Adds `none: none of these fits`, so the provider can say nothing fits. */
      abstain: z.boolean().default(true),
      orders: OrderRunsSchema.default("once"),
    })
    .refine((q) => !q.abstain || !q.options.map(optionKey).includes(ABSTAIN.key), {
      message: `"${ABSTAIN.key}" is the abstain option's key: rename that option or set abstain to false`,
    }),
  /** Rate on a scale, 1 to 5 unless given. */
  z.object({
    type: z.literal("score"),
    instructions: z.string().trim().min(1).max(500),
    min: z.number().int().default(1),
    max: z.number().int().default(5),
  }),
  /**
   * Is the statement in `instructions` true for the state? Laya asks it as a choice between two
   * neutral options, A and B, described by `criteria`, in both orders.
   */
  z.object({
    type: z.literal("noul"),
    instructions: z.string().trim().min(1).max(500),
    criteria: z.object({ true: Described, false: Described }).optional(),
  }),
]);
export type Question = z.infer<typeof QuestionSchema>;
export type ChoiceQuestion = Extract<Question, { type: "choice" }>;

/** A choice's options as the provider sees them: the given ones, then the abstain option. */
export function askedOptions(q: ChoiceQuestion): Option[] {
  return q.abstain ? [...choiceOptions(q), ABSTAIN] : choiceOptions(q);
}

/** The key of an option as given: a plain string is its own key. */
export function optionKey(o: string | Option): string {
  return typeof o === "string" ? o : o.key;
}

/** A choice's options, each as `{ key, description? }`. */
export function choiceOptions(q: ChoiceQuestion): Option[] {
  return q.options.map((o) => (typeof o === "string" ? { key: o } : o));
}

const FIELD = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * What the questions are about: text, or named fields the questions refer to by name
 * (`{ task, description, role }`). Trimmed to the provider's window (about 512 tokens for Laya).
 */
export const DecideStateSchema = z.union([
  z.string().min(1).max(20_000),
  z
    .record(z.string().regex(FIELD), z.string().max(20_000))
    .refine((s) => Object.keys(s).length >= 1 && Object.keys(s).length <= 12, "Give 1 to 12 fields")
    .refine((s) => Object.values(s).join("").length <= 20_000, "The fields are too long together"),
]);
export type DecideState = z.infer<typeof DecideStateSchema>;

/** The state as text, for providers that read text: a field per line, `name: value`. */
export function stateText(state: DecideState): string {
  if (typeof state === "string") return state;
  return Object.entries(state)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

export const DecideRequestSchema = z.object({
  state: DecideStateSchema,
  /** Question key to question, 1 to 8 questions. */
  questions: z
    .record(z.string().regex(FIELD), QuestionSchema)
    .refine((q) => Object.keys(q).length >= 1 && Object.keys(q).length <= 8, "Ask 1 to 8 questions"),
});
export type DecideRequest = z.infer<typeof DecideRequestSchema>;
/** A request as a caller writes it, before defaults are filled in. */
export type DecideRequestInput = z.input<typeof DecideRequestSchema>;

export const AnswerSchema = z.object({
  /** The option for `choice`, a number for `score`, a boolean for `noul`. */
  value: z.union([z.string(), z.number(), z.boolean()]),
  /** Probability per option (choice) or per value (score, noul), when the provider gives them. */
  probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
  confidence: z.number().min(0).max(1),
  /** The probabilities of each order run, when a choice was asked in more than one order. */
  runs: z.array(z.record(z.string(), z.number().min(0).max(1))).optional(),
});
export type Answer = z.infer<typeof AnswerSchema>;

export const DecisionResultSchema = z.object({
  id: z.string(),
  answers: z.record(z.string(), AnswerSchema),
  provider: ProviderIdSchema,
  /** Providers tried before this one, with why they did not answer. */
  skipped: z.array(z.object({ provider: ProviderIdSchema, reason: z.string() })),
  /** True when the state was cut to fit the provider's window. */
  trimmed: z.boolean(),
  /** True for self-reported probabilities (the ACP stand-in), shown as estimated. */
  estimated: z.boolean(),
  durationMs: z.number().nonnegative(),
});
export type DecisionResult = z.infer<typeof DecisionResultSchema>;

/** What a decision was for, in the log. */
export const DecisionUseSchema = z.enum(["tool", "model-pick", "owner", "routing"]);

export const DecisionRecordSchema = z.object({
  id: z.string(),
  at: z.string(),
  use: DecisionUseSchema,
  task: TaskIdSchema.optional(),
  agent: IdSchema.optional(),
  /** The question keys and instructions, one line each. */
  summary: z.string(),
  provider: ProviderIdSchema,
  answers: z.record(z.string(), AnswerSchema),
  estimated: z.boolean(),
  durationMs: z.number().nonnegative(),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

/** The native Laya runtime on the owner's Mac, run by the host helper. */
export const LayaStatusSchema = z.object({
  state: z.enum([
    /** Not an Apple silicon Mac, or no host helper. */
    "unsupported",
    "not-installed",
    "installing",
    "downloading",
    /** Installed; the model loads on the first question. */
    "ready",
    "loaded",
    "error",
  ]),
  detail: z.string().optional(),
  /** 0 to 1 while installing or downloading. */
  progress: z.number().min(0).max(1).optional(),
  version: z.string().optional(),
});
export type LayaStatus = z.infer<typeof LayaStatusSchema>;

/** `decisions:` in majhi.yaml. */
const decisionFields = {
  /** Providers in the order they are tried. */
  order: z.array(ProviderIdSchema).min(1),
  /** The agent that stands in for Laya or Jev (`acp`). Default: the boss. */
  acp_agent: IdSchema,
  /** `secret:<name>` for Jev's API key. Jev is skipped without one. */
  jev_key: z.string().regex(/^secret:[a-z0-9][a-z0-9-]{0,62}$/),
  /** Below this, an answer to the other decisions is not used. */
  min_confidence: z.number().min(0).max(1),
  /** Below this, a model pick falls back to the role's model tier. Laya spreads probability across similar models, so it is lower than `min_confidence`. */
  model_floor: z.number().min(0).max(1),
  /** Below this, an effort pick falls back to the role's effort tier. */
  effort_floor: z.number().min(0).max(1),
  /** Model and effort tiers per role. Orgs and agents can override them. */
  tiers: TiersPatchSchema,
  /** Calls to `majhi-decide` allowed per run, to catch loops. */
  per_run_limit: z.number().int().min(1).max(1000),
};
export const DecisionSettingsSchema = z.strictObject({
  order: decisionFields.order.default(["laya", "acp", "rules"]),
  acp_agent: decisionFields.acp_agent.optional(),
  jev_key: decisionFields.jev_key.optional(),
  min_confidence: decisionFields.min_confidence.default(0.6),
  model_floor: decisionFields.model_floor.default(0.4),
  effort_floor: decisionFields.effort_floor.default(0.4),
  /** Every role, with the defaults filled in for whatever majhi.yaml leaves out. */
  tiers: decisionFields.tiers.default({}).transform((patch): Tiers => {
    const tiers = { ...DEFAULT_TIERS };
    for (const role of RoleSchema.options) tiers[role] = resolveTier(role, patch[role]);
    return tiers;
  }),
  per_run_limit: decisionFields.per_run_limit.default(30),
});
export type DecisionSettings = z.infer<typeof DecisionSettingsSchema>;
/** Only the fields that are set (zod fills defaults inside `.partial()`, so this has none). */
export const DecisionPatchSchema = z.strictObject(decisionFields).partial();
