import { createHash } from "node:crypto";
import type {
  AutonomyAccount,
  AutonomyHold,
  AutonomyInstruction,
  AutonomyNow,
  AutonomySpend,
  AutonomyWaiting,
  CapUse,
  QueueItem,
  RoomItem,
  TaskPriority,
  TaskSize,
  UsageWindow,
} from "@majhi/shared";
import { capText } from "./spend.ts";
import { meets, stateWords } from "./waits.ts";

/**
 * The tick message (PRV-74, rule 8): what the captain reads each time majhi wakes it in the autonomy
 * chat. Pure. It stays under about 1,500 tokens: long lists are cut, and what is cut is counted.
 */

/** About 1,500 tokens, at four characters a token. */
export const DIGEST_MAX_CHARS = 6_000;
const LINE_MAX = 180;

/** An inbox or ready task of the backlog. */
export interface BacklogTask {
  id: string;
  org?: string | undefined;
  title: string;
  priority?: TaskPriority | undefined;
  due?: string | undefined;
  createdAt: string;
  /** Its size, when known. */
  size?: TaskSize | undefined;
}

/** A card the captain may answer with majhi_autonomy_answer. */
export interface AnswerableCard {
  task: string;
  item: string;
  kind: string;
  text: string;
}

export interface DigestInput {
  /** The lane's workspace: everything below is that workspace's only. */
  workspace?: string | undefined;
  now: Date;
  tz: string;
  /** Why the captain was woken: the lines since the last tick, oldest first. */
  reasons: readonly string[];
  spend: AutonomySpend;
  holds: readonly AutonomyHold[];
  accounts: readonly AutonomyAccount[];
  instructions: readonly AutonomyInstruction[];
  tasks: readonly AutonomyNow[];
  cards: readonly AnswerableCard[];
  waiting: readonly AutonomyWaiting[];
  /** The backlog the pick rules allow. */
  backlog: readonly BacklogTask[];
  /** How many backlog tasks the pick rules leave out. */
  leftOut: number;
  /** The owner's pick rules, one line each. */
  rules: readonly string[];
  queue: readonly QueueItem[];
  /** One line per project of the workspace: stack, readiness, when its card was read. */
  projects?: readonly string[] | undefined;
  /** Every account's health right now, by id, for the waits in the queue. */
  accountStatus?: Readonly<Record<string, AutonomyAccount["status"]>> | undefined;
  /** Open findings of the workspace, one line each, worst first. */
  findings?: readonly string[] | undefined;
  /**
   * Whether the captain decides when work starts here. False (Start is You): the lane files
   * proposals and does upkeep; it starts nothing.
   */
  starts?: boolean | undefined;
  /**
   * The owner's computer and majhi's containers, one line (the machine sensor). `busy` is why new
   * work must not start now. Absent: no sensor runs.
   */
  machine?: { line: string; busy?: string | undefined } | undefined;
}

/**
 * What the digest says apart from time, spend and what agents are doing at this moment: the facts a
 * wake is about. Two digests with the same key tell the captain the same news, so the second wake
 * is not sent. Sizes, spend, usage windows and `nowDoing` change without anything to decide, so they
 * stay out.
 */
export function factsKey(input: DigestInput): string {
  return createHash("sha1")
    .update(JSON.stringify(factsOf(input)))
    .digest("hex");
}

/** The facts a wake is about, as plain data: what `factsKey` hashes, and what a diff compares. */
export type Facts = Record<string, unknown>;

export function factsOf(input: DigestInput): Facts {
  return {
    workspace: input.workspace,
    starts: input.starts,
    holds: input.holds.map((h) => [h.kind, h.id, h.text, h.until]),
    accounts: input.accounts.map((a) => [a.id, a.org, a.status, a.blocked?.why]),
    instructions: input.instructions.map((i) => i.text),
    tasks: input.tasks.map((t) => [
      t.task,
      t.status,
      t.pause?.label,
      t.pause?.mayResume,
      t.agents.map((a) => a.id),
    ]),
    cards: input.cards.map((c) => [c.task, c.item]),
    waiting: input.waiting.map((w) => [w.task, w.item]),
    backlog: input.backlog.map((b) => [b.id, b.priority, b.due]),
    leftOut: input.leftOut,
    rules: input.rules,
    queue: input.queue.map((q) => [q.title, q.task, q.after, q.waitFor, q.readyAt !== undefined]),
    projects: input.projects,
    findings: input.findings,
    machineBusy: input.machine?.busy !== undefined,
  };
}

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

/** The backlog as autonomous mode takes it: high first, then the nearest due, then the oldest. */
export function backlogOrder<T extends BacklogTask>(tasks: readonly T[]): T[] {
  return [...tasks].sort(
    (a, b) =>
      PRIORITY_RANK[a.priority ?? "normal"] - PRIORITY_RANK[b.priority ?? "normal"] ||
      (a.due ?? "9999-12-31").localeCompare(b.due ?? "9999-12-31") ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
}

/** How many lines each list shows at full size. */
const BASE = {
  reasons: 10,
  holds: 6,
  accounts: 8,
  instructions: 10,
  tasks: 12,
  cards: 8,
  waiting: 6,
  backlog: 15,
  queue: 10,
  projects: 8,
  findings: 6,
};

export function digest(input: DigestInput): string {
  for (const scale of [1, 0.6, 0.4, 0.25]) {
    const text = build(input, scale);
    if (text.length <= DIGEST_MAX_CHARS) return text;
  }
  const text = build(input, 0.1);
  return text.length <= DIGEST_MAX_CHARS ? text : `${text.slice(0, DIGEST_MAX_CHARS - 4)}\n...`;
}

function build(input: DigestInput, scale: number): string {
  const max = (n: number) => Math.max(1, Math.floor(n * scale));
  const time = (iso: string) => when(iso, input.tz);
  const lines: string[] = [
    input.workspace === undefined
      ? `Autonomous mode, ${when(input.now.toISOString(), input.tz)} (${input.tz}).`
      : `Autonomous mode in ${input.workspace}, ${when(input.now.toISOString(), input.tz)} (${input.tz}). This lane holds ${input.workspace}'s matters only.`,
    "",
    ...newest("Why you were woken", input.reasons, max(BASE.reasons)),
    "",
    `Spend today: ${use(input.spend.total)}. Resets ${time(input.spend.resetsAt)}.`,
    ...input.spend.orgs.slice(0, max(BASE.accounts)).map((o) => `- ${o.org}: ${use(o)}`),
    ...more(input.spend.orgs.length - max(BASE.accounts)),
    ...(input.machine === undefined
      ? []
      : [
          `Machine: ${input.machine.line}.`,
          ...(input.machine.busy === undefined
            ? []
            : [
                `Do not start work: ${input.machine.busy}. majhi refuses starts until it calms down. Tell the owner which runs use the most and propose pausing one.`,
              ]),
        ]),
    ...list(
      "Holds on new work",
      input.holds.map((h) => `${h.text}${h.until === undefined ? "" : `, until ${time(h.until)}`}`),
      max(BASE.holds),
      "none",
    ),
    ...list(
      "Accounts",
      input.accounts.map(
        (a) =>
          `${a.id} (${a.org}, ${a.tool}, ${stateWords(a.status)} now): 5-hour ${left(a.window, input.tz)}, weekly ${left(a.weekly, input.tz)}${a.blocked === undefined ? "" : `. Held: ${a.blocked.why}`}`,
      ),
      max(BASE.accounts),
      "none",
    ),
    "",
    "The owner's pick rules (majhi refuses a start or create that breaks them):",
    ...input.rules.map((r) => `- ${r}`),
    ...list(
      "The owner's standing instructions",
      input.instructions.map((i) => i.text),
      max(BASE.instructions),
      "none",
    ),
    "",
    ...list(
      "Your tasks",
      input.tasks.map((t) => {
        const doing = t.agents.flatMap((a) => (a.nowDoing === undefined ? [] : [`@${a.id}: ${a.nowDoing}`]));
        const pause =
          t.pause === undefined
            ? ""
            : t.pause.mayResume
              ? ` (${t.pause.label}: you may resume it with majhi_tasks_start)`
              : ` (${t.pause.label}: ${t.pause.stays ?? "leave it paused"})`;
        return `${t.task} [${t.status}]${pause} ${t.title}${t.org === undefined ? "" : ` (${t.org})`}${doing.length === 0 ? "" : `. ${doing.join("; ")}`}`;
      }),
      max(BASE.tasks),
      "none yet",
    ),
    ...list(
      "Cards you may answer (majhi_autonomy_answer)",
      input.cards.map((c) => `${c.task}: ${c.text}`),
      max(BASE.cards),
      "none",
    ),
    ...list(
      "Left for the owner",
      input.waiting.map((w) => `${w.task} item ${w.item} (${w.kind}): ${w.text}. ${w.why}`),
      max(BASE.waiting),
      "none",
    ),
    "",
    ...list(
      "Backlog the rules allow, top first",
      backlogOrder(input.backlog).map((b) => {
        const tags = [
          b.size ?? "size not known",
          b.priority === undefined || b.priority === "normal" ? undefined : b.priority,
          b.due === undefined ? undefined : `due ${b.due}`,
        ].filter((t) => t !== undefined);
        return `${b.id}${b.org === undefined ? "" : ` (${b.org})`} [${tags.join(", ")}] ${b.title}`;
      }),
      max(BASE.backlog),
      "empty",
    ),
    ...(input.leftOut > 0 ? [`- ${input.leftOut} more left out by the pick rules`] : []),
    ...list(
      "Your queue",
      input.queue.map(
        (q, i) =>
          `${i + 1}. ${q.title}${q.task === undefined ? "" : ` (${q.task})`}: ${q.why}${q.after === undefined ? "" : `, not before ${time(q.after)}`}${waitText(q, input.accountStatus)}`,
      ),
      max(BASE.queue),
      "empty",
    ),
    ...((input.findings ?? []).length === 0
      ? []
      : list(
          "Open findings of this workspace (majhi_findings_list has the rest)",
          input.findings ?? [],
          max(BASE.findings),
          "none",
        )),
    ...((input.projects ?? []).length === 0
      ? []
      : list(
          "Projects of this workspace (majhi_projects_cards has the full card)",
          input.projects ?? [],
          max(BASE.projects),
          "none",
        )),
    "",
    ...(input.starts === false
      ? [
          "The owner decides when work starts in this workspace. Do not start tasks here. Use this wake for upkeep: look at findings and follow-ups, file proposals (majhi_findings_toTask makes an inbox task for the owner to approve), and check ship and review. majhi leaves anything else for the owner.",
        ]
      : []),
    "Decide what to do next, record it with majhi_autonomy_plan, and start what fits. End your turn when nothing more can start.",
  ];
  return lines.join("\n");
}

/** What a queue item waits for and where that stands now, read live: the item's own words can be old. */
function waitText(q: QueueItem, status: DigestInput["accountStatus"]): string {
  const wait = q.waitFor;
  if (wait === undefined) return "";
  const now = status?.[wait.account];
  const need = wait.state === "signed-in" ? "to be signed in" : "to be available";
  if (meets(wait, now)) {
    return `. READY: ${wait.account} is ${stateWords(now)} now, so this no longer waits. Start or resume it`;
  }
  return `. Waits for ${wait.account} ${need}; it is ${stateWords(now)} now`;
}

/** A titled list: at most `n` lines, then a count of the rest. */
function list(title: string, lines: readonly string[], n: number, empty: string): string[] {
  if (lines.length === 0) return [`${title}: ${empty}.`];
  return [`${title}:`, ...lines.slice(0, n).map((l) => `- ${clip(l)}`), ...more(lines.length - n)];
}

/** The newest `n` lines, oldest first, after a count of the earlier ones. */
function newest(title: string, lines: readonly string[], n: number): string[] {
  if (lines.length === 0) return [`${title}: a check, nothing new.`];
  const cut = Math.max(0, lines.length - n);
  return [
    `${title}:`,
    ...(cut > 0 ? [`- ${cut} earlier`] : []),
    ...lines.slice(cut).map((l) => `- ${clip(l)}`),
  ];
}

function more(n: number): string[] {
  return n > 0 ? [`- and ${n} more`] : [];
}

function clip(line: string): string {
  const one = line.replace(/\s+/g, " ").trim();
  return one.length > LINE_MAX ? `${one.slice(0, LINE_MAX - 3)}...` : one;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** "$1.20 and 1.2M tokens of $20.00 (6%)". */
function use(c: CapUse): string {
  const spent = `${money(c.used.cost)} and ${compact(c.used.tokens)} tokens`;
  return c.cap === undefined
    ? `${spent}, no cap`
    : `${spent} of ${capText(c.cap)} (${Math.round(c.percent)}%)`;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1_000) return `${Number((n / 1_000).toFixed(1))}k`;
  return String(n);
}

function left(w: UsageWindow | undefined, tz: string): string {
  if (w === undefined) return "unknown";
  const pct = `${Math.max(0, Math.round(100 - w.usedPct))}% left`;
  return w.resetsAt === undefined ? pct : `${pct} (resets ${when(w.resetsAt, tz)})`;
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** "Thu 1 Oct, 14:05" in the owner's zone. */
export function when(iso: string, tz: string): string {
  let f = formats.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formats.set(tz, f);
  }
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : f.format(at);
}

/** The line for a pending card the captain may answer, or undefined for any other item. */
export function answerableText(item: RoomItem): string | undefined {
  switch (item.type) {
    case "permission":
      return item.state === "pending" && item.connection === undefined
        ? `@${item.agent} asks to ${item.title} (permission ${item.id})`
        : undefined;
    case "ask":
      return item.state === "pending"
        ? `@${item.agent} asks: ${item.questions.map((q) => q.question).join(" / ")} (ask ${item.id})`
        : undefined;
    case "choice":
      return item.state === "pending" ? `a choice waits: ${item.question} (choice ${item.id})` : undefined;
    case "owner-question":
      return item.state === "pending"
        ? `@${item.agent} asks the owner (owner-question ${item.id})`
        : undefined;
    default:
      return undefined;
  }
}
