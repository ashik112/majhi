import { z } from "zod";
import { ReplyFlagsSchema } from "./chat.ts";
import { IdSchema, TaskIdSchema } from "./ids.ts";

/**
 * The captain's tools for one case (docs/briefs/case-flow.md). A case is the incident task a client's report opened;
 * the captain works it itself, here, with no lead, no plan steps and no new tasks. Each tool names the case.
 */

const CaseRef = TaskIdSchema.optional().describe(
  "The case: the task id chat_openIncident gave you. Left out, it is the case this turn is about",
);

/** The one live line the owner reads under the case in Work. */
export const CaseStatusInputSchema = z.object({
  case: CaseRef,
  now: z.string().trim().min(1).max(160).describe("What you are doing now, in one plain line"),
  next: z.string().trim().min(1).max(160).optional().describe("What comes next, in one plain line"),
});

/** Something to do later that this case found: a code fix, a monitor. A line on the case; never a task. */
export const CaseFollowUpInputSchema = z.object({
  case: CaseRef,
  text: z.string().trim().min(1).max(300),
});

const AskOptionInput = z.object({
  id: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(80),
});

/** One card in Needs you with buttons, for what cannot be undone: a deploy, a config or env change, a database write, money. */
export const CaseAskInputSchema = z.object({
  case: CaseRef,
  question: z.string().trim().min(1).max(300).describe('One plain question, like "Deploy fix X to Acme?"'),
  options: z
    .array(AskOptionInput)
    .min(2)
    .max(4)
    .describe("Two to four buttons. Put the one you recommend first"),
});

/** Closes the case when the client's symptom is checked as gone. */
export const CaseCloseInputSchema = z.object({
  case: CaseRef,
  summary: z
    .string()
    .trim()
    .min(1)
    .max(1200)
    .describe("Three to six lines for the owner: what broke, what you found, what you did, what to watch"),
  /** The last message to the client, sent with the close. Leave out when you told them already. */
  tell: ReplyFlagsSchema.extend({
    text: z.string().trim().min(1).max(1500),
    /** The client message it answers: the sender's user id and the message id. */
    to: z.string().max(200).optional(),
    replyTo: z.string().max(200).optional(),
  }).optional(),
});

/** What the case knows, what it tried and the one thing it needs, when it cannot go on. Writes the one card. */
export const CaseStopInputSchema = z.object({
  case: CaseRef,
  knows: z.string().trim().min(1).max(400),
  tried: z.string().trim().min(1).max(400),
  needs: z.string().trim().min(1).max(300).describe("The one thing you need from the owner"),
});

/**
 * One helper for a case: an agent of the workspace works the job inside the case, in its room and folder, and
 * reports back to the captain. For a code fix, name the project: the helper gets a branch and a worktree of it.
 */
export const CaseHelpInputSchema = z.object({
  case: CaseRef,
  agent: IdSchema.optional().describe("The agent to ask. Left out, the workspace's own lead"),
  project: IdSchema.optional().describe(
    "The project the helper changes, when the job is a code fix: it gets a branch and a worktree of it",
  ),
  job: z.string().trim().min(1).max(400).describe("The job in one line"),
});

/** Deploys the fix a helper wrote: the branch of the case's project, through the project's own deploy. */
export const CaseDeployInputSchema = z.object({
  case: CaseRef,
  branch: z.string().trim().min(1).max(200).describe("The helper's branch, as the case's helper reported it"),
  env: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .optional()
    .describe("The environment the client is on, when the project has several. Left out, the one the case names"),
  answers: z
    .record(z.string().trim().min(1).max(120), z.string().trim().min(1).max(300))
    .optional()
    .describe(
      "What the owner answered on the deploy card, by question id (env, components, previous-version, previous-commit). Only what the owner said",
    ),
});

/** Puts the version the last deploy of the case replaced back. Once per case. */
export const CaseRollbackInputSchema = z.object({ case: CaseRef });

export const CaseDeployResultSchema = z.object({
  ok: z.literal(true),
  note: z.string().optional(),
  env: z.string(),
  commit: z.string(),
  previous: z.string(),
  state: z.enum(["live", "failed"]),
});

/** The owner presses Make it a task on a follow-up. */
export const CaseMakeTaskInputSchema = z.object({
  case: TaskIdSchema,
  followUp: z.string().min(1).max(12),
});

export const CaseOkSchema = z.object({ ok: z.literal(true), note: z.string().optional() });
export const CaseMadeTaskSchema = z.object({ task: z.string(), started: z.boolean() });

export type CaseStatusInput = z.infer<typeof CaseStatusInputSchema>;
export type CaseFollowUpInput = z.infer<typeof CaseFollowUpInputSchema>;
export type CaseAskInput = z.infer<typeof CaseAskInputSchema>;
export type CaseCloseInput = z.infer<typeof CaseCloseInputSchema>;
export type CaseStopInput = z.infer<typeof CaseStopInputSchema>;
export type CaseHelpInput = z.infer<typeof CaseHelpInputSchema>;
export type CaseDeployInput = z.infer<typeof CaseDeployInputSchema>;
export type CaseRollbackInput = z.infer<typeof CaseRollbackInputSchema>;
export type CaseDeployResult = z.infer<typeof CaseDeployResultSchema>;
export type CaseMakeTaskInput = z.infer<typeof CaseMakeTaskInputSchema>;

/** The option ids of the card a stopped case writes, and what each does. */
export const CASE_STOP_MORE = "more";
export const CASE_STOP_CLOSE = "close";
