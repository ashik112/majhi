import type { CoordinationMode, HandoffVia, Role } from "@majhi/shared";
import { trimMiddle } from "../runs/handoff.ts";

/** The mentioning message is kept whole up to this, then cut in the middle. */
export const HANDOFF_MESSAGE_MAX = 4000;

export interface HandoffInput {
  task: string;
  from: string;
  to: { id: string; role: Role };
  via: HandoffVia;
  mode: CoordinationMode;
  /** The message that handed the work over. */
  text: string;
  /** Recent room lines, newest first, already within budget. */
  room: readonly string[];
  diffStat: string;
  /** The session has not read TASK.md yet. */
  needsBrief: boolean;
}

/** Asked of a reviewer so its verdict can be read without a model. */
export const VERDICT_ASK = "End your reply with APPROVED, or with CHANGES NEEDED and what to fix.";

/**
 * The prompt that wakes an agent another agent handed work to (SPEC 5.3): the message that did
 * it, a pointer to TASK.md, a short room summary and the diff stat. Not the whole chat: the agent
 * can read more of the room with majhi-room `read_recent`.
 */
export function handoffPrompt(input: HandoffInput): string {
  const why =
    input.via === "pipeline"
      ? `@${input.from} finished their step of the pipeline. Your step is next.`
      : input.via === "review-loop"
        ? input.to.role === "Reviewer"
          ? `@${input.from} finished a round of work. Review it.`
          : `@${input.from} reviewed your work and asks for changes. Fix them.`
        : `@${input.from} handed this to you in the room.`;
  const lines = [
    `${why} You are @${input.to.id} (${input.to.role}) in task ${input.task}.`,
    "",
    `@${input.from} wrote:`,
    quote(trimMiddle(input.text.trim(), HANDOFF_MESSAGE_MAX)),
    "",
  ];
  if (input.needsBrief)
    lines.push("First read TASK.md in this folder for the task, the team and the rules.", "");
  if (input.room.length > 0)
    lines.push("The room lately, newest first:", ...input.room.map((l) => `- ${l}`), "");
  lines.push(
    input.diffStat.trim() === ""
      ? "No changes in the worktrees yet."
      : `Changes so far:\n${input.diffStat.trimEnd()}`,
    "",
    "Your reply is posted to the room. To hand work on, mention the agent (for example @" +
      `${input.from}). Mention @owner only when you need the owner.`,
    "Do not ask the owner to merge, ship or review: when your work is done, majhi shows the owner a review card with Ship, Mark done and Ask for changes. Use the ask tool, with options, for any other decision you need from the owner (which approach, which option, whether to do something). A question in plain text is only a fallback.",
  );
  if (input.to.role === "Reviewer") lines.push(VERDICT_ASK);
  return lines.join("\n");
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}
