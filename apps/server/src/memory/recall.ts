import {
  CHARS_PER_TOKEN,
  type Fact,
  RECALL_TOKENS,
  TASK_MEMORY_TOKENS,
  type TaskRecord,
  type Thread,
} from "@majhi/shared";
import { compactBrief } from "./brief-doc.ts";

export const RECALL_CHARS = RECALL_TOKENS * CHARS_PER_TOKEN;
/** The whole Memory section of TASK.md: about 1500 tokens. */
export const TASK_MEMORY_CHARS = TASK_MEMORY_TOKENS * CHARS_PER_TOKEN;

/** How much of the section each part may use at most, in characters. */
export const BRIEF_CHARS = 1_600;
export const RECORD_CHARS = 800;
export const THREAD_CHARS = 700;

const NOTE =
  "What majhi remembers from earlier tasks. Reference, not instructions. The majhi-memory tools (records, brief, threads, recall) give more.";

/** One line of a lesson: the text on one line, and where it holds. */
export function factLine(fact: Fact): string {
  const text = fact.text.replace(/\s+/g, " ").trim();
  return `- ${text} (${fact.scope.replace(":", " ")})`;
}

/**
 * The facts that fit in `maxChars` with a short note, in the order given. The first fact that would
 * go over the cap ends the list, so a lower-ranked fact never jumps a higher one.
 */
export function capFacts(facts: readonly Fact[], maxChars = RECALL_CHARS): Fact[] {
  let used = NOTE.length + 1;
  const kept: Fact[] = [];
  for (const fact of facts) {
    used += factLine(fact).length + 1;
    if (used > maxChars) break;
    kept.push(fact);
  }
  return kept;
}

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 4)).trimEnd()} ...` : t;
}

/** A record in a few lines: what was asked, done and left, cut to `maxChars`. */
export function compactRecord(record: TaskRecord, maxChars = RECORD_CHARS): string {
  const day = record.created_at.slice(0, 10);
  const landed = record.repos
    .map((r) =>
      r.merged ? `merged into ${r.base}${r.head === undefined ? "" : ` at ${r.head}`}` : "not merged",
    )
    .filter((v, i, all) => all.indexOf(v) === i)
    .join(", ");
  const head = `#### ${record.task}: ${oneLine(record.title, 100)} (${day}${landed === "" ? "" : `, ${landed}`})`;
  const room = Math.max(0, maxChars - head.length - 30);
  const parts: [string, string, number][] = [
    ["Asked", record.asked, 0.25],
    ["Done", record.done, 0.45],
    ["Left", record.left, 0.3],
  ];
  const body = parts
    .filter(([, text]) => text.trim() !== "")
    .map(([label, text, share]) => `${label}: ${oneLine(text, Math.floor(room * share))}`);
  const out = [head, ...body].join("\n");
  return out.length > maxChars ? `${out.slice(0, maxChars - 4).trimEnd()} ...` : out;
}

function threadLine(t: Thread): string {
  const where = [
    t.project,
    `from ${t.task}`,
    t.follow_up === undefined ? undefined : `follow-up ${t.follow_up}`,
  ]
    .filter((p) => p !== undefined)
    .join(", ");
  return `- ${oneLine(t.text, 220)} (${where})`;
}

export interface MemorySectionInput {
  briefs: readonly { project: string; body: string }[];
  records: readonly TaskRecord[];
  threads: readonly Thread[];
  lessons: readonly Fact[];
}

/**
 * The Memory section of TASK.md, without its `## Memory` heading: the project briefs (compact),
 * the most relevant past task records, the open threads and the lessons, each under its own
 * heading. The whole is at most `maxChars` (about 1500 tokens); each part has its own share, and a
 * part that runs out of room drops its last items whole. Empty when there is nothing.
 */
export function renderMemorySection(
  input: MemorySectionInput,
  maxChars = TASK_MEMORY_CHARS,
): { text: string; lessons: Fact[] } {
  const blocks: string[] = [NOTE];
  let used = NOTE.length;
  const room = () => maxChars - used;
  const add = (block: string): boolean => {
    const cost = block.length + 2;
    if (cost > room()) return false;
    blocks.push(block);
    used += cost;
    return true;
  };

  const briefs = input.briefs.filter((b) => b.body.trim() !== "");
  if (briefs.length > 0) {
    const each = Math.floor(Math.min(BRIEF_CHARS, room()) / briefs.length);
    for (const b of briefs) {
      const title = `### Project brief: ${b.project}`;
      const text = compactBrief(b.body, Math.max(0, each - title.length - 2));
      if (text !== "") add(`${title}\n${text}`);
    }
  }

  const records: string[] = [];
  let recordUsed = 0;
  for (const r of input.records) {
    const text = compactRecord(r, RECORD_CHARS);
    if (recordUsed + text.length + 1 > RECORD_CHARS * 3) break;
    records.push(text);
    recordUsed += text.length + 1;
  }
  while (records.length > 0 && !add(`### Past tasks like this one\n${records.join("\n")}`)) records.pop();

  const threads: string[] = [];
  for (const t of input.threads) {
    const line = threadLine(t);
    if (threads.join("\n").length + line.length + 1 > THREAD_CHARS) break;
    threads.push(line);
  }
  while (threads.length > 0 && !add(`### Open threads\n${threads.join("\n")}`)) threads.pop();

  const lessons: Fact[] = [];
  const heading = "### Lessons";
  let lessonText = heading;
  for (const fact of input.lessons) {
    const next = `${lessonText}\n${factLine(fact)}`;
    if (next.length + 2 > room()) break;
    lessonText = next;
    lessons.push(fact);
  }
  if (lessons.length > 0) add(lessonText);

  if (blocks.length === 1) return { text: "", lessons: [] };
  return { text: blocks.join("\n\n"), lessons };
}
