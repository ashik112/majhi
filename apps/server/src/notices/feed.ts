import {
  CAPTAIN,
  ClientOutcomeSchema,
  type DeployRecord,
  actorOfName,
  type Notice,
  type NoticeList,
  NOTICE_LIMIT,
  type OwnerDecision,
  PRIVATE,
  type UpdateStatus,
  didWords,
  incidentDecisionId,
  signInDecisionId,
} from "@majhi/shared";
import { z } from "zod";
import { oneLine } from "../notify/attention.ts";
import type { BugRow, ClientLine, IncidentRow, TaskStatusRow } from "../store/notices.ts";

/** Everything the feed is made from, read once. The feed is a pure function of this. */
export interface FeedSources {
  /** What waits for the owner now (the Needs you list). */
  decisions: readonly OwnerDecision[];
  clientLines: readonly ClientLine[];
  taskStatuses: readonly TaskStatusRow[];
  bugs: readonly BugRow[];
  incidents: readonly IncidentRow[];
  deploys: readonly DeployRecord[];
  update: UpdateStatus | undefined;
  marks: { seen: string | undefined; rows: ReadonlySet<string> };
  /** Only this workspace's rows. */
  org?: string | undefined;
  /** Oldest time a non-waiting event may have (ISO). */
  since: string;
}

/** The workspace a task row belongs to: Private for a task of none. */
const orgOfTask = (org: string | null): string => org ?? PRIVATE;

/** The workspace of a decision: its org, Private for a task of none, nothing for an account or a budget. */
function orgOfDecision(d: OwnerDecision): string | undefined {
  return d.org ?? (d.task === undefined ? undefined : PRIVATE);
}

const SIGN_IN_PREFIX = signInDecisionId("");

/** What a ready-to-ship decision says, by its main answer: Merge, Fix with agent, Mark done. */
const SHIP_WORDS: Readonly<Record<string, string>> = {
  merge: "ready to merge",
  fix: "failed its checks",
  done: "finished",
};

/** The decision as a row: a plain subject, the task or the asker's words as detail, and its main answer as the button. */
function decisionNotice(d: OwnerDecision): Omit<Notice, "read"> {
  const task = d.task ?? "";
  const named = (words: string) => oneLine(task === "" ? words : `${task} ${words}`);
  let subject: string;
  let detail: string | undefined;
  switch (d.kind) {
    case "ship":
      subject = named(SHIP_WORDS[d.options[0]?.id ?? ""] ?? "ready for review");
      detail = d.taskTitle ?? d.title;
      break;
    case "question":
      subject = named("has a question");
      detail = d.title;
      break;
    case "approval":
      subject = named("needs your approval");
      detail = d.title;
      break;
    case "secret":
      subject = named("needs a secret");
      detail = d.title;
      break;
    case "sign-in":
      subject = `${d.id.slice(SIGN_IN_PREFIX.length)} is signed out`;
      detail =
        d.waits === undefined || d.waits.length === 0
          ? "Its agents cannot run"
          : `Waiting on it: ${d.waits.join(", ")}`;
      break;
    default:
      subject = d.title;
      detail = d.taskTitle;
  }
  // The same button as on the Needs you page: the primary answer, unless it needs typed words.
  const main = d.options.find((o) => o.primary === true && o.text !== true);
  const hint = d.suggestion;
  const hinted = hint === undefined ? undefined : (d.options.find((o) => o.id === hint.option)?.label ?? hint.option);
  const says =
    hint === undefined || hinted === undefined
      ? undefined
      : `${hint.by === "captain" ? "Captain says" : "The agent suggests"} ${hinted.toLowerCase()}.`;
  return {
    id: `decision:${d.id}`,
    kind: "decision",
    ...(orgOfDecision(d) === undefined ? {} : { org: orgOfDecision(d) }),
    at: d.at,
    subject: oneLine(subject, 160),
    ...(detail === undefined ? {} : { detail: oneLine(detail) }),
    needsYou: true,
    link: d.link,
    ...(main === undefined ? { openLabel: d.kind === "sign-in" ? "Sign in" : "Open" } : {}),
    ...(main === undefined ? {} : { answer: { decision: d.id, option: main.id, label: main.label, ...(says === undefined ? {} : { says }) } }),
  };
}

const ClientMessage = z.object({
  // Only what the row shows. The message's other sender fields are not this feed's to check.
  sender: z.object({ name: z.string().optional(), bot: z.boolean().optional() }),
  us: z.boolean().optional(),
  deleted: z.boolean().optional(),
  text: z.string().default(""),
  outcome: ClientOutcomeSchema.optional(),
});
const ClientReply = z.object({
  by: z.enum(["captain", "you"]),
  state: z.enum(["held", "sent", "failed", "discarded"]),
  text: z.string().default(""),
});

/** Whether a client message should reach the owner, by the chat's Notify setting. An urgent one always does. */
function notifies(notify: string | null, outcome: z.infer<typeof ClientOutcomeSchema> | undefined): boolean {
  if (outcome?.urgent === true) return true;
  if (notify === "every") return true;
  if (notify === "none") return false;
  return outcome?.state === "waits" || outcome?.state === "failed";
}

function parse<T>(schema: z.ZodType<T>, payload: string): T | undefined {
  try {
    const result = schema.safeParse(JSON.parse(payload));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** The newest client message and the newest reply sent to a client, per room: a busy chat is one row, not thirty. */
function clientNotices(lines: readonly ClientLine[]): Omit<Notice, "read">[] {
  const out: Omit<Notice, "read">[] = [];
  const seen = new Set<string>();
  // Lines come newest first.
  for (const line of lines) {
    const link = { kind: "chat" as const, id: line.room };
    const org = orgOfTask(line.org);
    if (line.type === "client") {
      const msg = parse(ClientMessage, line.payload);
      if (msg === undefined || msg.us === true || msg.deleted === true || msg.sender.bot === true) continue;
      if (!notifies(line.notify, msg.outcome)) continue;
      const key = `${line.room}:client`;
      if (seen.has(key)) continue;
      seen.add(key);
      const name = msg.sender.name === undefined || msg.sender.name === "" ? "Client" : msg.sender.name;
      out.push({
        id: `client:${line.room}:${line.item}`,
        kind: "client-message",
        org,
        at: line.at,
        subject: oneLine(line.title, 160),
        detail: oneLine(`${name}: ${msg.text}`),
        needsYou: false,
        link,
      });
    } else {
      const reply = parse(ClientReply, line.payload);
      // A held reply is a decision already; the owner's own replies need no bell.
      if (reply === undefined || reply.by !== "captain" || (reply.state !== "sent" && reply.state !== "failed"))
        continue;
      const key = `${line.room}:reply`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `reply:${line.room}:${line.item}`,
        kind: "client-reply",
        org,
        at: line.at,
        subject: oneLine(
          reply.state === "sent"
            ? didWords(CAPTAIN, "replied", `in ${line.title}`)
            : `Reply failed in ${line.title}`,
          160,
        ),
        detail: oneLine(reply.text),
        needsYou: false,
        link,
      });
    }
  }
  return out;
}

const PAUSE_WORDS: Readonly<Record<string, string>> = {
  limit: "account limit",
  offline: "offline",
  error: "error",
  loop: "agents going in circles",
  blocked: "blocked by another task",
  "signed-out": "account signed out",
};

/** A task in review, done or paused. The owner's own moves are left out, and so is what Needs you already holds. */
function taskNotices(
  rows: readonly TaskStatusRow[],
  waiting: ReadonlySet<string>,
): Omit<Notice, "read">[] {
  const out: Omit<Notice, "read">[] = [];
  for (const row of rows) {
    const actor = actorOfName(row.actor);
    if (actor.kind === "owner") continue;
    const base = {
      org: orgOfTask(row.org),
      at: row.at,
      detail: oneLine(row.title),
      needsYou: false,
      link: { kind: "task" as const, id: row.id },
    };
    const id = `task:${row.id}:${row.event}`;
    if (row.status === "review") {
      // A ready-to-ship decision says it, with the button.
      if (waiting.has(`ship:${row.id}`)) continue;
      out.push({ ...base, id, kind: "task-review", subject: `${row.id} ready for review` });
    } else if (row.status === "done") {
      out.push({ ...base, id, kind: "task-done", subject: `${row.id} done` });
    } else {
      if (waiting.has(`paused:${row.id}`)) continue;
      const cause = row.hold === null ? undefined : PAUSE_WORDS[row.hold];
      out.push({
        ...base,
        id,
        kind: "task-paused",
        subject: oneLine(`${didWords(actor, "paused")}${cause === undefined ? "" : `: ${cause}`}`, 160),
        detail: oneLine(`${row.id} ${row.title}`),
      });
    }
  }
  return out;
}

function deployNotices(deploys: readonly DeployRecord[]): Omit<Notice, "read">[] {
  return deploys.map((d) => {
    const where = `${d.project} to ${d.env}`;
    const words =
      d.state === "live" ? `Deploy ${where}: live` : d.state === "failed" ? `Deploy ${where} failed` : `Deploy ${where} rolled back`;
    const detail = d.state === "live" ? d.task : (d.reason ?? d.task);
    return {
      id: `deploy:${d.id}:${d.state}`,
      kind: "deploy" as const,
      org: d.org,
      at: d.finishedAt ?? d.updatedAt,
      subject: oneLine(words, 160),
      ...(detail === undefined ? {} : { detail: oneLine(detail) }),
      needsYou: false,
      link: d.task === undefined ? { kind: "page" as const, page: "projects" as const } : { kind: "task" as const, id: d.task },
    };
  });
}

function incidentNotices(
  rows: readonly IncidentRow[],
  waiting: ReadonlySet<string>,
  since: string,
): Omit<Notice, "read">[] {
  const out: Omit<Notice, "read">[] = [];
  const link = { kind: "page" as const, page: "watch" as const };
  for (const row of rows) {
    const detail = oneLine(row.service === null ? `${row.severity} severity` : `${row.service}, ${row.severity} severity`);
    if (row.openedAt >= since && !waiting.has(incidentDecisionId(row.id))) {
      out.push({
        id: `incident:${row.id}:opened`,
        kind: "incident",
        org: row.org,
        at: row.openedAt,
        subject: oneLine(`Incident opened: ${row.title}`, 160),
        detail,
        needsYou: false,
        link,
      });
    }
    if (row.resolvedAt !== null && row.resolvedAt >= since) {
      out.push({
        id: `incident:${row.id}:resolved`,
        kind: "incident",
        org: row.org,
        at: row.resolvedAt,
        subject: oneLine(`Incident resolved: ${row.title}`, 160),
        detail,
        needsYou: false,
        link,
      });
    }
  }
  return out;
}

const BUG_PREFIX = "majhi bug: ";

function bugNotices(rows: readonly BugRow[]): Omit<Notice, "read">[] {
  return rows.map((b) => ({
    id: `bug:${b.id}`,
    kind: "bug" as const,
    org: orgOfTask(b.org),
    at: b.at,
    subject: didWords(CAPTAIN, "filed a bug"),
    detail: oneLine(b.title.startsWith(BUG_PREFIX) ? b.title.slice(BUG_PREFIX.length) : b.title),
    needsYou: false,
    link: { kind: "task" as const, id: b.id },
  }));
}

function updateNotices(update: UpdateStatus | undefined, since: string): Omit<Notice, "read">[] {
  if (update === undefined || update.state === "running" || update.startedAt < since) return [];
  return [
    {
      id: `update:${update.startedAt}`,
      kind: "update" as const,
      at: update.startedAt,
      subject: update.state === "done" ? "majhi updated" : "majhi update failed",
      detail: oneLine(update.state === "done" ? `Build ${update.commit.slice(0, 7)}` : (update.error ?? update.commit.slice(0, 7))),
      needsYou: false,
      link: { kind: "page" as const, page: "setup" as const },
    },
  ];
}

/**
 * The bell's feed, newest first. What waits for the owner is always in it; everything else is an event
 * of the last week. A row that Needs you already holds is not said twice: the decision stands for it.
 * A row is read when its time is not after the "seen up to" mark, or the owner read it on its own.
 */
export function buildFeed(src: FeedSources): NoticeList {
  const waiting = new Set(src.decisions.flatMap((d) => (d.task === undefined ? [] : [`${d.kind}:${d.task}`, d.id])));
  const all = [
    ...src.decisions.map(decisionNotice),
    ...clientNotices(src.clientLines),
    ...taskNotices(src.taskStatuses, waiting),
    ...deployNotices(src.deploys),
    ...incidentNotices(src.incidents, waiting, src.since),
    ...bugNotices(src.bugs),
    ...updateNotices(src.update, src.since),
  ];
  const { seen, rows } = src.marks;
  const scoped = src.org === undefined ? all : all.filter((n) => n.org === src.org);
  const notices: Notice[] = scoped
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : 1))
    .slice(0, NOTICE_LIMIT)
    .map((n) => ({ ...n, read: (seen !== undefined && n.at <= seen) || rows.has(n.id) }));
  const unread = notices.filter((n) => !n.read);
  return { notices, unread: unread.length, unreadNeedsYou: unread.filter((n) => n.needsYou).length };
}
