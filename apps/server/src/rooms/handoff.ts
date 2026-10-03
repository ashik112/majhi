import type { CoordinationMode, HandoffVia, Role } from "@majhi/shared";

/**
 * The mentioning message is kept whole up to this, the most `mention` and `post` accept. A longer
 * final reply is cut at the end, with a marker that says where and how to read the rest.
 */
export const HANDOFF_MESSAGE_MAX = 20_000;

export interface HandoffInput {
  task: string;
  from: string;
  to: { id: string; role: Role };
  via: HandoffVia;
  mode: CoordinationMode;
  /** The message that handed the work over. */
  text: string;
  /** The handoff room item, which keeps the whole message for read_recent. */
  itemId: string;
  /** Recent room lines, newest first, already within budget. */
  room: readonly string[];
  diffStat: string;
  /** The session has not read TASK.md yet. */
  needsBrief: boolean;
}

/** Asked of a reviewer so its verdict can be read without a model. */
export const VERDICT_ASK = "End your reply with APPROVED, or with CHANGES NEEDED and what to fix.";

/** What every handoff prompt says first. Fixed text, so it is the same in every one. */
export const HANDOFF_RULES = [
  'Your reply is posted to the room. To hand work on, start a line with "@name:" or use the mention tool; a name in the middle of a sentence wakes nobody. Mention @owner only when you need the owner. With nothing to hand on, address no one: a message that addresses nobody wakes nobody.',
  "Do not ask the owner to merge, ship or review: when your work is done, majhi shows the owner a review card with Ship, Mark done and Ask for changes. Use the ask tool, with options, for any other decision you need from the owner (which approach, which option, whether to do something). A question in plain text is only a fallback.",
].join("\n");

/**
 * The prompt that wakes an agent another agent handed work to (SPEC 5.3): the message that did
 * it, a pointer to TASK.md, a short room summary and the diff stat, after the fixed rules. Not the whole chat: the agent
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
  // The fixed text comes first, then what is new in this handoff: the same opening every time is
  // what a provider's prompt cache can reuse (SPEC 5.9 item 7).
  const lines = [
    ...(input.to.role === "Reviewer" ? [HANDOFF_RULES, VERDICT_ASK] : [HANDOFF_RULES]),
    "",
    `${why} You are @${input.to.id} (${input.to.role}) in task ${input.task}.`,
    "",
    `@${input.from} wrote:`,
    ...handoffMessage(input.text.trim(), input.itemId),
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
  );
  return lines.join("\n");
}

/** The message quoted whole, or its start and a marker naming where it was cut and how to read on. */
function handoffMessage(text: string, itemId: string): string[] {
  if (text.length <= HANDOFF_MESSAGE_MAX) return [quote(text)];
  return [
    quote(text.slice(0, HANDOFF_MESSAGE_MAX)),
    "",
    `[Message cut here: this is the first ${HANDOFF_MESSAGE_MAX} of ${text.length} characters. ` +
      `Read the whole message before you start: call majhi-room read_recent with item "${itemId}".]`,
  ];
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}
