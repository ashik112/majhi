import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { HANDOFF_STEP_IDS, type HandoffLog, type HandoffStepId } from "@majhi/shared";

/**
 * The full output of every step of a hand-off check, kept as files in the task folder so the file
 * viewer opens them: `.checks/<run>/<step>.log`. One folder per run, the newest few kept. Nothing
 * here reads a path from the output of a command or from an agent: a run id and a step id are the
 * only parts of a path, each checked, and the folder is refused when it is a link.
 */

/** The folder of a task's check logs. `.handoffs` is taken: it holds the agents' session notes. */
export const CHECKS_DIR = ".checks";
/** How many runs of one task keep their logs. */
export const KEEP_RUNS = 5;

/** The most characters of one step's output a log keeps: the viewer shows a text file up to 1 MB. */
export const LOG_CAP_CHARS = 950_000;
/** Of the cap, how much is the start of the output (the first error is usually there) and how much its end (the summary). */
const HEAD_CHARS = 350_000;
const TAIL_CHARS = LOG_CAP_CHARS - HEAD_CHARS;

/** A run id: a time in base 36 and a random suffix, only `[0-9a-z-]`. Sorts oldest first. */
export function newRunId(now: number = Date.now()): string {
  return `${now.toString(36)}-${randomBytes(3).toString("hex")}`;
}

function plainName(text: string): boolean {
  if (text.length === 0 || text.length > 40 || text.startsWith("-")) return false;
  for (const ch of text) {
    const ok = (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "z") || ch === "-";
    if (!ok) return false;
  }
  return true;
}

const isStep = (name: string): name is HandoffStepId =>
  (HANDOFF_STEP_IDS as readonly string[]).includes(name);

/** The path of a step's log under the task folder, or a refusal for a run or step that is not a plain name. */
export function logPath(run: string, step: string): string {
  if (!plainName(run)) throw new Error(`Not a check run id: ${run}`);
  if (!isStep(step)) throw new Error(`Not a check step: ${step}`);
  return `${CHECKS_DIR}/${run}/${step}.log`;
}

/** The one dot path the task files route serves besides session notes: `.checks/<run>/<step>.log`. */
export function isCheckLog(segments: readonly string[]): boolean {
  const [dir, run, file] = segments;
  if (segments.length !== 3 || dir !== CHECKS_DIR || run === undefined || file === undefined) return false;
  return plainName(run) && file.endsWith(".log") && isStep(file.slice(0, -".log".length));
}

/** Throws unless `path` is a real folder (not a link) that sits inside `folder`, symlinks followed. */
async function plainFolder(folder: string, path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${path} is not a plain folder`);
  const [root, real] = await Promise.all([realpath(folder), realpath(path)]);
  const rel = relative(root, real);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error(`${path} is outside ${folder}`);
}

/**
 * Writes one step's log. Never follows a link: the agents write in the task folder too, so a link
 * put in place of `.checks` or a run folder must not send majhi's write anywhere else.
 */
export async function writeStepLog(
  folder: string,
  run: string,
  step: HandoffStepId,
  text: string,
): Promise<string> {
  const rel = logPath(run, step);
  const checks = join(folder, CHECKS_DIR);
  await mkdir(checks, { recursive: true });
  await plainFolder(folder, checks);
  const dir = join(checks, run);
  await mkdir(dir, { recursive: true });
  await plainFolder(folder, dir);
  // `wx`: an existing file, or a link left at the path, is refused instead of written through.
  await writeFile(join(folder, rel), text, { flag: "wx", mode: 0o644 });
  return rel;
}

/** Removes the runs of a task beyond the newest `keep`. A missing folder is nothing to do. */
export async function pruneRuns(folder: string, keep: number = KEEP_RUNS): Promise<void> {
  const checks = join(folder, CHECKS_DIR);
  let names: string[];
  try {
    await plainFolder(folder, checks);
    names = (await readdir(checks)).filter(plainName).sort();
  } catch {
    return;
  }
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    await rm(join(checks, name), { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Keeps the start and the end of a stream of output within a cap, in memory that never passes about
 * twice the cap, and says in the text where the middle was left out.
 */
export class OutputKeeper {
  private head = "";
  private tail = "";
  private dropped = 0;

  push(chunk: string): void {
    let rest = chunk;
    if (this.head.length < HEAD_CHARS) {
      const take = HEAD_CHARS - this.head.length;
      this.head += rest.slice(0, take);
      rest = rest.slice(take);
    }
    if (rest === "") return;
    this.tail += rest;
    if (this.tail.length > TAIL_CHARS * 2) {
      const over = this.tail.length - TAIL_CHARS;
      this.dropped += over;
      this.tail = this.tail.slice(over);
    }
  }

  /** What was kept and how many characters were left out of the middle. */
  result(): { text: string; cut: number } {
    if (this.tail.length > TAIL_CHARS) {
      const over = this.tail.length - TAIL_CHARS;
      this.dropped += over;
      this.tail = this.tail.slice(over);
    }
    if (this.dropped === 0) return { text: this.head + this.tail, cut: 0 };
    return { text: `${this.head}${cutLine(this.dropped)}${this.tail}`, cut: this.dropped };
  }
}

/** The line that marks where a log was cut. */
export function cutLine(dropped: number): string {
  return `\n[majhi: output cut at ${(LOG_CAP_CHARS / 1_000_000).toFixed(2)} MB, ${dropped.toLocaleString("en")} characters left out here]\n`;
}

/** A whole text cut to the cap the same way a stream is: its start, a marker, its end. */
export function capLog(text: string): { text: string; cut: number } {
  const keeper = new OutputKeeper();
  keeper.push(text);
  return keeper.result();
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/**
 * The log of one step: each command's output under a line that says what ran and how it ended.
 * It knows which line the output the card shows (`tail`) begins at, so the viewer can open there:
 * counted from the shape of the text, never read out of it.
 */
export class StepLog {
  private text = "";
  private lines = 0;
  /** The line the card's tail starts at, when a section gave one. */
  private focus: number | undefined;

  /** Adds one command's output. `tail`, when given, is the end of it as the card shows it: the log opens at its first line. */
  add(header: string, output: string, tail = ""): void {
    const body = output.endsWith("\n") || output === "" ? output : `${output}\n`;
    const start = this.lines + 2;
    this.text += `${header}\n${body}`;
    this.lines += 1 + lineCount(body);
    if (tail !== "") {
      this.focus = start + Math.max(0, lineCount(output.trimEnd()) - tail.split("\n").length);
    }
  }

  /** The log as it will be saved, cut to the cap, and what the card needs to open it. */
  finish(path: string): { text: string; log: HandoffLog } {
    const capped = capLog(this.text);
    const total = lineCount(capped.text);
    const uncut = this.focus ?? 1;
    // A cut takes lines out of the middle and never out of the end, so count the line from the end.
    const focus = capped.cut === 0 ? uncut : total - (this.lines - uncut);
    return {
      text: capped.text,
      log: {
        path,
        bytes: Buffer.byteLength(capped.text),
        lines: total,
        ...(capped.cut > 0 ? { cut: capped.cut } : {}),
        focus: Math.min(Math.max(1, focus), Math.max(1, total)),
      },
    };
  }
}
