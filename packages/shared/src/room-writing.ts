/**
 * How an agent writes in the room: one text, read from here by TASK.md, the captain's own instructions, the
 * autonomy preamble and the captain agent created in setup, so the rule is said once and the same everywhere.
 */
export const WRITING_IN_THE_ROOM_TITLE = "Writing in the room";

export const WRITING_IN_THE_ROOM_LINES: readonly string[] = [
  "The owner reads your message in seconds, in the room or on Home. Write it so.",
  "- First line, in bold: the outcome. What is true now, in one sentence.",
  '- Then "Needs you", with one line per action, only when the owner must act. Leave it out when they do not.',
  "- No story of what you checked, and do not repeat the task back.",
  "- Cause, evidence, timeline and follow-ups go in REPORT.md. Link it from the message.",
  "- Six lines at most.",
];

/** The rule as one block of text, with its title on top. */
export const WRITING_IN_THE_ROOM: string = [
  `${WRITING_IN_THE_ROOM_TITLE}:`,
  ...WRITING_IN_THE_ROOM_LINES,
].join("\n");
