import type { NotifyKind, PausedReason, PendingNotice, RoomItem } from "@majhi/shared";

/** What the owner is told about one item, before settings decide where it goes. */
export interface Attention {
  kind: NotifyKind;
  text: string;
}

/** The task as a notification names it: the id for work, the title for a chat. */
export interface Subject {
  id: string;
  title: string;
  chat: boolean;
}

export function subjectName(task: Subject): string {
  return task.chat ? task.title : task.id;
}

/** Where the owner finds the item: the room of the task, or of the chat. */
export function pathOf(task: Subject): string {
  return task.chat ? `/chats/${task.id}` : `/t/${task.id}`;
}

/** Pauses that need the owner. `owner` is the owner's own stop; `offline` resumes by itself. */
const PAUSE_TEXT: Partial<Record<PausedReason, string>> = {
  limit: "paused: the account hit its usage limit",
  error: "paused after an error",
  "signed-out": "paused: an account is signed out",
  loop: "stopped: the agents are going in circles",
  blocked: "is blocked and waits for you",
};

function oneLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The notification for an item that waits for the owner, or undefined when the item is not one: an
 * answered card, an agent's message, a pause the owner made. This is the one list of what needs the owner.
 */
export function attentionOf(item: RoomItem, who: string): Attention | undefined {
  switch (item.type) {
    case "permission":
      return item.state === "pending"
        ? { kind: "approval", text: `${who} needs approval: ${oneLine(item.title)}` }
        : undefined;
    case "approval":
      return item.state === "pending"
        ? { kind: "approval", text: `${who} needs approval: ${oneLine(item.summary)}` }
        : undefined;
    case "secret-request":
      return item.state === "pending"
        ? { kind: "secret", text: `${who} needs a secret: ${oneLine(item.label)}` }
        : undefined;
    case "ask":
      return item.state === "pending"
        ? { kind: "question", text: `${who} asks: ${oneLine(item.questions[0]?.question ?? "a question")}` }
        : undefined;
    case "choice":
      return item.state === "pending"
        ? { kind: "question", text: `${who} needs a decision: ${oneLine(item.question)}` }
        : undefined;
    case "owner-question":
      return item.state === "pending"
        ? { kind: "question", text: `@${item.agent} in ${who} is asking you something` }
        : undefined;
    case "review":
      return item.state === "pending"
        ? {
            kind: "review",
            text: item.ready === undefined ? `${who} is ready for review` : `${who} is ready to ship`,
          }
        : undefined;
    case "paused": {
      const text = PAUSE_TEXT[item.reason];
      return item.state === "pending" && text !== undefined
        ? { kind: "stopped", text: `${who} ${text}` }
        : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * The notifications list (`notify.pending`): every waiting item of a task that is still open, with
 * the line its notification shows. `subject` gives undefined for a task that is gone or done.
 */
export function pendingNotices(
  items: readonly RoomItem[],
  subject: (task: string) => Subject | undefined,
): PendingNotice[] {
  return items.flatMap((item) => {
    const task = subject(item.task);
    const attention = task === undefined ? undefined : attentionOf(item, subjectName(task));
    return attention === undefined
      ? []
      : [{ task: item.task, item: item.id, kind: attention.kind, text: attention.text, at: item.at }];
  });
}

/** "4 things need you". */
export function groupText(count: number): string {
  return `${count} things need you`;
}

const CLOCK = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

function minutesOf(clock: string): number | undefined {
  const m = CLOCK.exec(clock);
  return m === null ? undefined : Number(m[1]) * 60 + Number(m[2]);
}

/** The minutes since midnight at `at` in `tz` (or the server's zone when `tz` is missing or wrong). */
function localMinutes(at: number, tz: string | undefined): number {
  const date = new Date(at);
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(tz === undefined ? {} : { timeZone: tz }),
    }).formatToParts(date);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return get("hour") * 60 + get("minute");
  } catch {
    return date.getHours() * 60 + date.getMinutes();
  }
}

/** True between `from` and `to` (24 h clock). A window that ends before it starts runs over midnight. */
export function inQuietHours(
  at: number,
  quiet: { from?: string | undefined; to?: string | undefined; tz?: string | undefined },
): boolean {
  const from = quiet.from === undefined ? undefined : minutesOf(quiet.from);
  const to = quiet.to === undefined ? undefined : minutesOf(quiet.to);
  if (from === undefined || to === undefined || from === to) return false;
  const now = localMinutes(at, quiet.tz);
  return from < to ? now >= from && now < to : now >= from || now < to;
}
