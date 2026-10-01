import { z } from "zod";
import { IdSchema } from "./accounts.ts";

/**
 * Teams in a room (SPEC 5.3): how agents take turns, per-task agent overrides, and @mentions
 * in agent and owner messages. Shared by the server (routing) and the web (chips, pickers).
 */

/**
 * - `lead`: the lead plans and assigns by mention; the owner gets the task when the work is approved.
 * - `pipeline`: each role runs once in order: lead, builders, reviewer, tester.
 * - `review-loop`: builder and reviewer alternate until the reviewer approves, at most `review_rounds` rounds.
 */
export const CoordinationModeSchema = z.enum(["lead", "pipeline", "review-loop"]);
export type CoordinationMode = z.infer<typeof CoordinationModeSchema>;

export const MODE_LABELS: Record<CoordinationMode, string> = {
  lead: "Lead delegates",
  pipeline: "Pipeline",
  "review-loop": "Build and review loop",
};

/** The owner's choices for one agent in one task. They win over the agent file (5.1). */
export const TeamOverrideSchema = z.object({
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  /** Projects this agent edits in this task. Absent: every repo of the task. Empty: none (it only reads). */
  repos: z.array(IdSchema).optional(),
});
export type TeamOverride = z.infer<typeof TeamOverrideSchema>;

/** Why an agent was woken by another. */
/** `guard`: majhi's loop guard woke the lead once to break a loop, before it pauses the room. */
export const HandoffViaSchema = z.enum(["mention", "pipeline", "review-loop", "tool", "guard"]);
export type HandoffVia = z.infer<typeof HandoffViaSchema>;

/** Written by the owner or an agent to hand the task back to the owner. */
export const OWNER_HANDLE = "owner";

const MENTION = /(?<![A-Za-z0-9_@/.-])@([A-Za-z0-9][A-Za-z0-9-]*)(?![A-Za-z0-9_/@-]|\.[A-Za-z0-9])/g;
/** Fenced blocks and inline code: a mention there is quoted, not addressed. */
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

/**
 * The agents a message addresses, in order of first mention, lowercased. Only ids in `known`
 * count, plus `owner`. Mentions inside code are ignored, and so is quoted text (lines starting
 * with `>`), so an agent quoting an earlier message does not wake its author again.
 */
/** `@/absolute/path`: a folder or file the owner points an agent at. Not an agent mention (those start with a letter). */
const PATH_MENTION = /(?<![A-Za-z0-9_@/.-])@(\/[^\s`'"<>|*?]+)/g;

/**
 * The absolute paths a message mentions as `@/path`, in order, once each. Trailing punctuation
 * (`.`, `,`, `;`, `:`, `)`, `!`, `?`) is not part of the path. Code and quoted lines are ignored,
 * like agent mentions. Paths with `..` or a NUL are dropped here; the server still checks the rest.
 */
export function parsePathMentions(text: string): string[] {
  const plain = text
    .replace(CODE, (m) => " ".repeat(m.length))
    .split("\n")
    .map((line) => (/^\s*>/.test(line) ? "" : line))
    .join("\n");
  const out: string[] = [];
  for (const m of plain.matchAll(PATH_MENTION)) {
    const path = (m[1] ?? "").replace(/[.,;:)!?\]]+$/, "").replace(/\/+$/, "");
    if (path === "" || path.split("/").includes("..") || path.includes("\0")) continue;
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

export function parseMentions(text: string, known: Iterable<string>): string[] {
  const ids = new Set([...known].map((k) => k.toLowerCase()));
  const plain = text
    .replace(CODE, (m) => " ".repeat(m.length))
    .split("\n")
    .map((line) => (/^\s*>/.test(line) ? "" : line))
    .join("\n");
  const out: string[] = [];
  for (const m of plain.matchAll(MENTION)) {
    const id = (m[1] ?? "").toLowerCase();
    if ((ids.has(id) || id === OWNER_HANDLE) && !out.includes(id)) out.push(id);
  }
  return out;
}
