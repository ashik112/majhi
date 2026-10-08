import type { RoomItem } from "@majhi/shared";

/**
 * The room's quiet lines (system notes, handoffs, plans, compactions) as one short line each, with the full text behind an expander. Values set in backticks
 * (`opus`) show in mono; @handles and task ids link as in any message.
 */

type SystemItem = Extract<RoomItem, { type: "system" }>;

export interface Quiet {
  /** One line, backticks around values. */
  short: string;
  /** The whole text, shown when the line is opened. Absent when the short line says it all. */
  detail?: string | undefined;
}

/** Longer than this, a plain line folds its full text behind the expander. */
const FOLD_OVER = 110;

// What the run manager and the model pick write (apps/server/src/runs/manager.ts and pick.ts).
const START = /^@(\S+) (started|resumed) on (\S+), model (\S+), effort (\S+)$/;
const PICK = /^@(\S+) \(([^)]+)\)\. /;
const PLAN_USED = /^(Plan(?: v\d+)? used)(?: \(with subtasks\))?: (.*)$/;
const TOKENS = /([\d.]+)(k|M|B)? tokens \(\$([\d.]+)\)/g;

interface Start {
  agent: string;
  verb: string;
  account: string;
  model: string;
  effort: string;
}

function parseStart(text: string): Start | undefined {
  const m = START.exec(text);
  if (!m) return undefined;
  const [, agent = "", verb = "", account = "", model = "", effort = ""] = m;
  return { agent, verb, account, model, effort };
}

interface Pick {
  agent: string;
  model: string | undefined;
  effort: string | undefined;
  why: string;
}

function parsePick(text: string): Pick | undefined {
  const head = PICK.exec(text);
  if (!head) return undefined;
  const models = text.indexOf("Models offered:");
  const efforts = text.indexOf("Efforts offered:");
  const modelPart = models === -1 ? "" : text.slice(models, efforts === -1 ? undefined : efforts);
  const effortPart = efforts === -1 ? "" : text.slice(efforts);
  return { agent: head[1] ?? "", model: picked(modelPart), effort: picked(effortPart), why: ratingWhy(text) };
}

function picked(part: string): string | undefined {
  return /Picked (\S+) \(/.exec(part)?.[1] ?? /Only (\S+) is offered/.exec(part)?.[1];
}

/** "Laya rated the task medium", or why the role's own tiers were kept. */
function ratingWhy(text: string): string {
  const rated = /([^.]+?) rated the task (\w+)(, but that does not count)?/.exec(text);
  if (rated) {
    const by = (rated[1] ?? "").trim();
    return rated[3] ? `${by}'s rating (${rated[2]}) did not count` : `${by} rated the task ${rated[2]}`;
  }
  if (text.includes("No provider rated the task")) return "no rating, so the role's tiers";
  if (text.includes("said no level fits")) return "no level fits, so the role's tiers";
  return "";
}

function values(model: string | undefined, effort: string | undefined): string {
  return [model && `\`${model}\``, effort && `\`${effort}\` effort`].filter(Boolean).join(", ");
}

const TOKEN_UNIT: Record<string, number> = { k: 1e3, M: 1e6, B: 1e9 };

function tokensText(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

/** "Plan v3 used: @a 18.9M tokens ($4.23), @b 14M tokens ($3.12)" as its sum. */
function planUsed(text: string): Quiet | undefined {
  const m = PLAN_USED.exec(text);
  if (!m) return undefined;
  let tokens = 0;
  let cost = 0;
  let agents = 0;
  for (const t of (m[2] ?? "").matchAll(TOKENS)) {
    tokens += Number(t[1]) * (TOKEN_UNIT[t[2] ?? ""] ?? 1);
    cost += Number(t[3]);
    agents += 1;
  }
  if (agents === 0) return undefined;
  const who = agents === 1 ? "" : ` across ${agents} agents`;
  return { short: `${m[1]} \`${tokensText(tokens)}\` tokens, \`$${cost.toFixed(2)}\`${who}`, detail: text };
}

/** One system note as a short line. */
export function quietSystem(text: string): Quiet {
  const start = parseStart(text);
  if (start) {
    return {
      short: `@${start.agent} ${start.verb} on \`${start.account}\` with ${values(start.model, start.effort)}`,
    };
  }
  const pick = parsePick(text);
  if (pick) {
    const chose = values(pick.model, pick.effort);
    const head = chose === "" ? `@${pick.agent} kept its settings` : `@${pick.agent} picked ${chose}`;
    return { short: pick.why === "" ? head : `${head}: ${pick.why}`, detail: text };
  }
  const plan = planUsed(text);
  if (plan) return plan;
  return { short: text, detail: text.length > FOLD_OVER ? text : undefined };
}

/**
 * System notes posted in the same moment, as one line. A session start followed by its model pick
 * reads "@lead resumed on `claude` with `opus`, `high` effort (Laya rated the task medium)".
 */
export function quietGroup(texts: readonly string[]): Quiet {
  const [first, second] = texts;
  if (texts.length === 1 && first !== undefined) return quietSystem(first);
  if (texts.length === 2 && first !== undefined && second !== undefined) {
    const start = parseStart(first);
    const pick = parsePick(second);
    if (start && pick && start.agent === pick.agent) {
      const why = pick.why === "" ? "" : ` (${pick.why})`;
      return {
        short: `@${start.agent} ${start.verb} on \`${start.account}\` with ${values(start.model, start.effort)}${why}`,
        detail: second,
      };
    }
  }
  return {
    short: texts.map((t) => quietSystem(t).short).join(" · "),
    detail: texts.join("\n"),
  };
}

/** Notes this close together were posted by one step, so they read as one line. */
const SAME_MOMENT_MS = 3_000;

/** Whether `next` was posted with the notes of `group`, so it joins their line. */
export function sameMoment(group: readonly SystemItem[], next: SystemItem): boolean {
  const last = group.at(-1);
  return last !== undefined && Math.abs(Date.parse(next.at) - Date.parse(last.at)) <= SAME_MOMENT_MS;
}

/** A line split into plain text and backticked values, in order. */
export function valueParts(text: string): { text: string; value: boolean }[] {
  return text
    .split("`")
    .map((part, i) => ({ text: part, value: i % 2 === 1 }))
    .filter((part) => part.text !== "");
}
