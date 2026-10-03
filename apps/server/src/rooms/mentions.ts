import type { DecideRequestInput, DecisionResult } from "@majhi/shared";
import { plainText } from "./coordinate.ts";

/**
 * Whether a mention asks a teammate to act (5.3). An agent that names a teammate only to report
 * status or say who it waits on should not wake it: that is how rooms went in circles. The words
 * catch plain status (`statusOnly`) and plain asks (`asksByWords`); for the rest the decision
 * provider is asked one yes/no per mentioned agent, and only a sure "no" keeps an agent asleep.
 */

/** How much of the message the provider reads: Laya's window is about 512 tokens. */
export const MENTION_STATE_MAX = 1_200;
/** Questions per request, at most; agents past it are woken as before. */
const MAX_ASKED = 8;

/**
 * Whether a sure "no" keeps the agent asleep. On by the labeled eval (`eval/mention-eval.ts`): with
 * `QUIET_MIN_LIFT`, Laya said no sure "no" to a clear request there. Off, a "no" is logged and the
 * agent wakes.
 */
export const QUIET_ON_NO = true;
/**
 * A "no" keeps an agent asleep only this far over chance, stricter than the gate: a wrong "no"
 * leaves work undone, a wrong "yes" costs one turn. In the eval, Laya's wrong "no"s on clear
 * requests were at 0.22 and 0.26, and its right ones at 0.53 and over.
 */
export const QUIET_MIN_LIFT = 0.5;

/**
 * The message as the provider reads it: the agent's own words (no code, no quotes), and when that
 * is too long, the first sentence for context, the sentences that mention one of `agents`, and the
 * sentence after each: a handoff often puts the ask on the line after "@x:".
 */
export function mentionText(text: string, agents: readonly string[], max = MENTION_STATE_MAX): string {
  const plain = plainText(text).replace(/\s+\n/g, "\n").trim();
  if (plain.length <= max) return plain;
  const sentences = sentencesOf(plain);
  const mentions = agents.map((a) => `@${a.toLowerCase()}`);
  const names = (s: string | undefined) =>
    s !== undefined && mentions.some((n) => s.toLowerCase().includes(n));
  const kept = sentences.filter((s, i) => i === 0 || names(s) || names(sentences[i - 1]));
  const joined = kept.join(" ");
  return joined.length <= max ? joined : `${joined.slice(0, max - 1)}…`;
}

/** Sentences of plain text, the way the room reads them. */
function sentencesOf(plain: string): string[] {
  return plain
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

const PLEASE = /^(please|kindly)\b/i;
/** Words that ask whoever is addressed for something. */
const POLITE = /^(can you|could you|would you|will you|over to you|your turn|go ahead)\b/i;
/** Verbs that give work, as a sentence addressed to a teammate starts: "@x: build ...". */
const VERB =
  /^(build|review|fix|add|implement|write|check|test|run|re-?run|take|pick|start|look|update|change|remove|delete|rename|investigate|verify|merge|commit|push|create|make|finish|continue|handle|refactor|rebase|retry|revert|deploy|ship|try|answer|confirm|decide|read|open|port|move|wire|set|use|own|draft|prepare|plan|split|document|help|resume|proceed|apply|address|debug|measure|compare|clean|carry|pull|install|upgrade|migrate|land|double-check|audit|research|explore|find|search|lint|format|stop|hold|pause|keep|tell|share|post|send|report|summarize|design|reply|respond|reproduce|profile|bump|regenerate|rewrite|restore|resolve|close|extract|rework|tidy|polish|finalize|align|unblock|sync|backport|deliver|wrap)\b/i;

/** A sentence without list markers and emphasis, so "- **@x**: please" reads as "@x: please". */
function bare(sentence: string): string {
  return sentence
    .replace(/[*_]{2,3}/g, "")
    .replace(/^([-+>#]+|\d+[.)])\s*/, "")
    .trim();
}

/**
 * Whether the message asks `agent` for something by its words alone, so the decision provider is
 * not asked and a wrong "no" cannot drop a handoff. A sentence that starts with the mention and
 * goes on with "please", "can you" or a verb that gives work ("@x: please build", "@x, review the
 * diff"), or whose next sentence does ("@x:" then the ask on the next line, "@x the build is up.
 * Run the tests."). "@x please" anywhere, and a sentence that starts with "please" right after the
 * one with the mention, count too. "Thanks @x" or "as @x said" ask nothing. Code and quotes are not read.
 */
export function asksByWords(text: string, agent: string): boolean {
  const sentences = sentencesOf(plainText(text)).map(bare);
  const name = agent.replace(/[^A-Za-z0-9_-]/g, "");
  const mention = new RegExp(`(^|[^A-Za-z0-9_@/.-])@${name}(?![A-Za-z0-9_-])`, "i");
  for (const [i, sentence] of sentences.entries()) {
    const found = mention.exec(sentence);
    if (found === null) continue;
    const at = found.index + (found[1] ?? "").length;
    const rest = sentence
      .slice(at + name.length + 1)
      .replace(/^\s*[:,–—-]?\s*/, "")
      .trim();
    const next = sentences[i + 1] ?? "";
    const addressed = at === 0;
    if (PLEASE.test(rest) || PLEASE.test(next)) return true;
    if (addressed && (POLITE.test(rest) || VERB.test(rest) || VERB.test(next))) return true;
    if (addressed && /^[.!]?$/.test(rest) && POLITE.test(next)) return true;
  }
  return false;
}

/** One or more names at the start of a sentence, as "@a @b: please ..." or "@a, @b and @c ...". */
const LEADING_NAMES = /^(?:@[A-Za-z0-9_][A-Za-z0-9_-]*(?:\s*,\s*|\s+and\s+|\s+&\s+|\s+)?)+/i;

/**
 * Whether a mention of `agent` addresses it: the name starts a line or a sentence, after list
 * markers and emphasis, alone or in a run of names ("@a @b: please ..."). "Reported to @x", "as @x
 * said" and "thanks @x" name an agent in passing and address nobody. Code and quotes are not read.
 */
export function addresses(text: string, agent: string): boolean {
  const name = agent.replace(/[^A-Za-z0-9_-]/g, "").toLowerCase();
  if (name === "") return false;
  return sentencesOf(plainText(text))
    .map(bare)
    .some((sentence) => {
      const run = LEADING_NAMES.exec(sentence)?.[0] ?? "";
      return [...run.matchAll(/@([A-Za-z0-9_][A-Za-z0-9_-]*)/g)].some((m) => m[1]?.toLowerCase() === name);
    });
}

/** What the writer of a quieted mention is told, so a handoff it meant does not just vanish. */
export function quietNote(quiet: readonly string[]): string {
  const who = quiet.map((a) => `@${a}`).join(", ");
  const them = quiet.length === 1 ? "them" : "any of them";
  return `${who} ${quiet.length === 1 ? "was" : "were"} not woken: your message did not ask ${them} for anything. To hand work on, start a line with "@name: please ..." or use the majhi-room mention tool; a name in the middle of a sentence wakes nobody. Otherwise there is nothing to do.`;
}

/** What the writer is told when an agent it named in passing was not added to the team. */
export function notAddedNote(agents: readonly string[]): string {
  const who = agents.map((a) => `@${a}`).join(", ");
  const first = agents[0] ?? "name";
  return `${who} ${agents.length === 1 ? "was" : "were"} not added to the team: your message named ${agents.length === 1 ? "them" : "each of them"} in the middle of a sentence. To bring ${agents.length === 1 ? "them" : "one"} in, start a line with "@${first}: please ..." or use the majhi-room mention tool.`;
}

/** The question key for the i-th agent asked. */
function key(i: number): string {
  return `acts_${i + 1}`;
}

/** One yes/no per agent: does the message ask it to do something now? */
export function mentionQuestion(from: string, agents: readonly string[], text: string): DecideRequestInput {
  const asked = agents.slice(0, MAX_ASKED);
  return {
    state: { from: `@${from}`, message: mentionText(text, asked) },
    questions: Object.fromEntries(
      asked.map((agent, i) => [
        key(i),
        {
          type: "noul" as const,
          instructions: `Does the message ask @${agent} to do something now?`,
          criteria: {
            true: `it asks @${agent} to do, fix, check, answer or decide something now`,
            false: `it only reports status or waiting, or names @${agent} without asking it to act`,
          },
        },
      ]),
    ),
  };
}

export interface MentionReading {
  /** A sure yes: woken. */
  act: string[];
  /** A sure no, `QUIET_MIN_LIFT` over chance: not woken when `QUIET_ON_NO`. */
  quiet: string[];
  /** Not sure, or not asked: woken, as before. */
  unsure: string[];
}

/** What the provider said for each agent of `mentionQuestion`. No result reads as unsure. */
export function readMentions(agents: readonly string[], result: DecisionResult | undefined): MentionReading {
  const reading: MentionReading = { act: [], quiet: [], unsure: [] };
  agents.forEach((agent, i) => {
    const a = result?.answers[key(i)];
    if (a === undefined || a.gate?.accepted !== true) reading.unsure.push(agent);
    else if (a.value === true) reading.act.push(agent);
    else if (a.gate.lift >= QUIET_MIN_LIFT) reading.quiet.push(agent);
    else reading.unsure.push(agent);
  });
  return reading;
}
