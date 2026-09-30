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

export const GateSchema = z.object({
  accepted: z.boolean(),
  /** Why, in plain words: "0.31 over chance, 0.19 ahead" or what fell short. */
  reason: z.string(),
  /** `(n * p - 1) / (n - 1)`: 0 is a random pick, 1 is certain. */
  lift: z.number(),
  /** The answer's probability minus the next most probable option's. */
  margin: z.number(),
});
export type Gate = z.infer<typeof GateSchema>;

export const AnswerSchema = z.object({
  /** The option for `choice`, a number for `score`, a boolean for `noul`. */
  value: z.union([z.string(), z.number(), z.boolean()]),
  /** Probability per option (choice) or per value (score, noul), when the provider gives them. */
  probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
  confidence: z.number().min(0).max(1),
  /** The probabilities of each order run, when a choice was asked in more than one order. */
  runs: z.array(z.record(z.string(), z.number().min(0).max(1))).optional(),
  /** Whether the answer is sure enough to act on, set by majhi from `decisions.min_lift` and `min_margin`. */
  gate: GateSchema.optional(),
});
export type Answer = z.infer<typeof AnswerSchema>;

export interface GateSettings {
  min_lift: number;
  min_margin: number;
}

/** How many options the provider chose among: a choice's options and the abstain option, a score's levels, 2 for a yes/no. */
export function optionCount(q: Question): number {
  if (q.type === "choice") return askedOptions(q).length;
  if (q.type === "score") return Math.max(2, q.max - q.min + 1);
  return 2;
}

/** Two decimals, cut instead of rounded, so a number just under a bar never reads as reaching it. */
function cut2(n: number): string {
  return (Math.floor(n * 100 + 1e-9) / 100).toFixed(2);
}

/**
 * Whether an answer counts. It does when it is not the abstain option, beats chance by `min_lift`
 * (chance-adjusted, so the bar means the same for any number of options), and leads the runner-up by
 * `min_margin`. Without probabilities the rest is taken as spread evenly over the other options.
 */
export function gateAnswer(q: Question, a: Answer, s: GateSettings): Gate {
  const n = optionCount(q);
  const key = String(a.value);
  const probabilities = a.probabilities ?? {};
  const p = probabilities[key] ?? a.confidence;
  const others = Object.entries(probabilities).filter(([k]) => k !== key);
  const [runnerUp, second] = others.reduce<[string | undefined, number]>(
    (best, [k, v]) => (v > best[1] ? [k, v] : best),
    [undefined, others.length === 0 ? (1 - p) / (n - 1) : 0],
  );
  const lift = (n * p - 1) / (n - 1);
  const margin = p - second;
  const numbers = { lift, margin };
  if (q.type === "choice" && q.abstain && a.value === ABSTAIN.key)
    return { accepted: false, reason: "it said none of the options fits", ...numbers };
  if (lift < s.min_lift)
    return {
      accepted: false,
      reason: `${cut2(lift)} over chance, under ${s.min_lift.toFixed(2)}`,
      ...numbers,
    };
  if (margin < s.min_margin)
    return {
      accepted: false,
      reason: `${cut2(margin)} ahead of ${runnerUp ?? "the next option"}, under ${s.min_margin.toFixed(2)}`,
      ...numbers,
    };
  return { accepted: true, reason: `${cut2(lift)} over chance, ${cut2(margin)} ahead`, ...numbers };
}

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

/** What majhi did with a decision, recorded by the code that asked. */
export const DecisionOutcomeSchema = z.object({
  /** In plain words: "large, so most capable (acme-large-2) and highest (max)". */
  text: z.string().max(1000),
  /** True when the answer did not count and a fallback was used instead. */
  fellBack: z.boolean(),
  /** What the owner can name as the right answer in "Wrong pick", when it is not the question's options. */
  choices: z.array(z.string().min(1).max(100)).max(40).optional(),
});
export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;

/** The owner's "Wrong pick": what the right answer was. */
export const DecisionCorrectionSchema = z.object({
  right: z.string().trim().min(1).max(100),
  note: z.string().trim().max(500).optional(),
  at: z.string(),
});
export type DecisionCorrection = z.infer<typeof DecisionCorrectionSchema>;

/** A question as the provider got it: Laya's own format, one per order run. */
const SentQuestionSchema = z.looseObject({
  type: z.string(),
  instructions: z.string(),
  criteria: z.union([z.array(z.string()), z.record(z.string(), z.string())]).optional(),
});

export const DecisionRecordSchema = z.object({
  id: z.string(),
  at: z.string(),
  use: DecisionUseSchema,
  task: TaskIdSchema.optional(),
  agent: IdSchema.optional(),
  /** The question keys and instructions, one line each. */
  summary: z.string(),
  provider: ProviderIdSchema,
  /** Every answer with its probabilities, its order runs and its gate. */
  answers: z.record(z.string(), AnswerSchema),
  estimated: z.boolean(),
  durationMs: z.number().nonnegative(),
  /** The whole request, secrets hidden: the state as sent (after fitting), the questions, and what the provider got. */
  request: z
    .object({
      state: z.union([z.string(), z.record(z.string(), z.string())]),
      questions: z.record(z.string(), QuestionSchema),
      sent: z.record(z.string(), SentQuestionSchema).optional(),
    })
    .optional(),
  trimmed: z.boolean().optional(),
  skipped: z.array(z.object({ provider: ProviderIdSchema, reason: z.string() })).optional(),
  /** The provider's version or checkpoint, when known: "laya-mlx 0.2.0". */
  version: z.string().optional(),
  outcome: DecisionOutcomeSchema.optional(),
  correction: DecisionCorrectionSchema.optional(),
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
  /**
   * An answer counts only when it beats chance by this much: `(n * p - 1) / (n - 1)` for the
   * answer's probability `p` among `n` options, 0 for a random pick and 1 for a certain one. The
   * same bar means the same thing for 2 options or 20, which a fixed probability floor does not.
   */
  min_lift: z.number().min(0).max(1),
  /** ...and leads the next most probable option by at least this much. */
  min_margin: z.number().min(0).max(1),
  /** Older fixed floors, replaced by `min_lift` and `min_margin`. Still read so an older majhi.yaml loads; not used. */
  min_confidence: z.number().min(0).max(1),
  model_floor: z.number().min(0).max(1),
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
  min_lift: decisionFields.min_lift.default(0.2),
  min_margin: decisionFields.min_margin.default(0.05),
  min_confidence: decisionFields.min_confidence.optional(),
  model_floor: decisionFields.model_floor.optional(),
  effort_floor: decisionFields.effort_floor.optional(),
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
