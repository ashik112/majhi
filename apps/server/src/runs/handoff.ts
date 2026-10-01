import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomItem } from "@majhi/shared";
import { sectionOf } from "../tasks/brief.ts";

/**
 * Handoff notes (SPEC 5.13): what carries a task from a full session to a fresh one. The agent
 * writes one with a fixed template; when it cannot, majhi builds one from durable state
 * without calling a model. Pure text functions plus saving the file.
 */

export const HANDOFF_DIR = ".handoffs";

/** The fixed headings, in order. */
export const HANDOFF_HEADINGS = [
  "Original task",
  "Done",
  "Key decisions",
  "Remaining work",
  "Files touched",
  "Next step",
] as const;

/** What majhi asks the agent before replacing its session. The reply is the note. */
export const HANDOFF_REQUEST = [
  "majhi is about to move you to a fresh session to keep your context small.",
  "Reply with a handoff note for yourself and nothing else. Use exactly these markdown headings, in this order, and keep it under 600 words:",
  "",
  ...HANDOFF_HEADINGS.map((h) => `## ${h}`),
  "",
  'Under "Next step" write one concrete action. Do not run tools and do not change files for this reply.',
].join("\n");

/** Said first in every fresh session. Short and fixed, so it caches. */
export const FRESH_PREFIX = [
  "majhi replaced your previous session to keep the context small. Continue silently from where you left off.",
  "Your notes, the task and the current state follow. Do not redo finished work. Re-read only the files you need.",
].join(" ");

/** Budgets, in characters (about four per token). */
export const BUDGET = {
  taskMd: 6000,
  room: 6000,
  roomItem: 600,
  diff: 4000,
  roomSummary: 1500,
  note: 12_000,
} as const;

/** Keeps the start and end of long text, with a marker in the middle. */
export function trimMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = "\n[... trimmed ...]\n";
  const keep = Math.max(0, max - marker.length);
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (keep - head))}`;
}

/** True when the agent's reply looks like the template: most of the headings are there. */
export function looksLikeNote(text: string): boolean {
  const found = HANDOFF_HEADINGS.filter((h) => new RegExp(`^#+\\s*${h}\\b`, "im").test(text));
  return found.length >= 4;
}

/** One line per room item for notes and summaries, or undefined for items that say nothing useful. */
export function itemLine(item: RoomItem): string | undefined {
  switch (item.type) {
    case "owner":
      // A queued message is not part of the story yet (it comes as its own prompt), a removed one never is.
      return item.text.trim() === "" || item.queued || item.removed === true ? undefined : `Owner: ${item.text.trim()}`;
    case "agent":
      return item.text.trim() === "" ? undefined : `@${item.agent}: ${item.text.trim()}`;
    case "tool":
      return `Tool ${item.status}: ${item.title}`;
    case "system":
      return item.level === "info" ? undefined : `majhi (${item.level}): ${item.text}`;
    case "approval":
      return `Command ${item.command}: ${item.state}`;
    case "plan":
      return `Plan: ${item.entries.map((e) => `[${e.status === "completed" ? "x" : " "}] ${e.content}`).join("; ")}`;
    case "team-plan":
      return `Team plan v${item.version}: ${item.steps.map((s, i) => `${i + 1}. ${s.who} ${s.what}`).join(" ")} Why: ${item.why}`;
    default:
      return undefined;
  }
}

/**
 * Room items since a point, newest first, each trimmed, until the budget is used.
 * `items` may come in any order; they are sorted by `seq`.
 */
export function roomLines(
  items: readonly RoomItem[],
  budget: number,
  perItem: number = BUDGET.roomItem,
): string[] {
  const out: string[] = [];
  let used = 0;
  for (const item of [...items].sort((a, b) => b.seq - a.seq)) {
    const line = itemLine(item);
    if (line === undefined) continue;
    const trimmed = trimMiddle(line.replace(/\s+/g, " "), perItem);
    if (used + trimmed.length > budget) break;
    out.push(trimmed);
    used += trimmed.length + 1;
  }
  return out;
}

export interface DurableState {
  task: string;
  agent: string;
  /** TASK.md as it is on disk, or empty when it cannot be read. */
  taskMd: string;
  /** The last checkpoint number, 0 for none. */
  checkpoint: number;
  /** Room items since the checkpoint. */
  room: readonly RoomItem[];
  /** `git diff --stat` plus the diff, per repo, already joined. */
  diff: string;
  /** Why majhi built the note itself. */
  why: string;
}

/** The note majhi writes when the agent cannot: the same headings, filled from durable state. */
export function durableNote(s: DurableState): string {
  const room = roomLines(s.room, BUDGET.room);
  const text = [
    `# Handoff note for @${s.agent} on ${s.task}`,
    "",
    `Written by majhi from saved state (${s.why}).`,
    "",
    "## Original task",
    "",
    // The fresh prompt carries TASK.md whole, so the note repeats only the brief.
    trimMiddle(
      sectionOf(s.taskMd, "Brief") || s.taskMd.trim() || "TASK.md could not be read. See the task folder.",
      BUDGET.taskMd,
    ),
    "",
    "## Done",
    "",
    s.checkpoint > 0
      ? `Work up to checkpoint ${s.checkpoint} is committed on the task branch. The room since then, newest first:`
      : "No checkpoint yet. The room so far, newest first:",
    "",
    ...(room.length > 0 ? room.map((l) => `- ${l}`) : ["- Nothing yet."]),
    "",
    "## Key decisions",
    "",
    "See the room lines above and TASK.md.",
    "",
    "## Remaining work",
    "",
    "Whatever the task asks that the diff below does not cover yet.",
    "",
    "## Files touched",
    "",
    s.diff.trim() === ""
      ? "No changes in the worktrees."
      : ["```", trimMiddle(s.diff.trim(), BUDGET.diff), "```"].join("\n"),
    "",
    "## Next step",
    "",
    "Check the diff against the task, then continue with the first thing left undone.",
    "",
  ].join("\n");
  return trimMiddle(text, BUDGET.note);
}

export interface FreshInput {
  taskMd: string;
  note: string;
  /** Short room summary lines, newest first. */
  room: readonly string[];
  diffStat: string;
  /** The prompt that was waiting, verbatim, or undefined when none was. */
  pending?: string | undefined;
}

/**
 * The first prompt of a fresh session, in this order: the fixed prefix, TASK.md, the note, a
 * short room summary, the diff stat, then the pending prompt verbatim.
 */
export function freshPrompt(input: FreshInput): string {
  return [
    FRESH_PREFIX,
    "",
    "# TASK.md",
    "",
    trimMiddle(input.taskMd.trim(), BUDGET.taskMd),
    "",
    "# Handoff note",
    "",
    trimMiddle(input.note.trim(), BUDGET.note),
    "",
    "# Room, newest first",
    "",
    ...(input.room.length > 0 ? input.room.map((l) => `- ${l}`) : ["- Nothing new."]),
    "",
    "# Changes so far (diff stat)",
    "",
    input.diffStat.trim() === "" ? "No changes." : trimMiddle(input.diffStat.trim(), BUDGET.diff),
    "",
    input.pending === undefined
      ? "# Next\n\nContinue from where you left off."
      : `# The owner's message\n\n${input.pending}`,
  ].join("\n");
}

/** `.handoffs/<agent>-<n>.md` with the next free n, relative to the task folder. */
export async function nextNotePath(folder: string, agent: string): Promise<string> {
  let names: string[] = [];
  try {
    names = await readdir(join(folder, HANDOFF_DIR));
  } catch {
    // No notes yet.
  }
  const pattern = new RegExp(`^${agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)\\.md$`);
  const taken = names.flatMap((n) => {
    const m = pattern.exec(n);
    return m?.[1] === undefined ? [] : [Number(m[1])];
  });
  const n = taken.length === 0 ? 1 : Math.max(...taken) + 1;
  return `${HANDOFF_DIR}/${agent}-${n}.md`;
}

/** Saves a note under the task folder and returns its relative path. */
export async function saveNote(folder: string, agent: string, note: string): Promise<string> {
  const rel = await nextNotePath(folder, agent);
  await mkdir(join(folder, HANDOFF_DIR), { recursive: true });
  await writeFile(join(folder, rel), note.endsWith("\n") ? note : `${note}\n`);
  return rel;
}
