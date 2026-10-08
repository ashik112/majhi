import {
  CHAT_APP_LABEL,
  type ChatFile,
  type ClientOutcome,
  type ClientRow,
  captainPayDecisionId,
  PAGE_PATH,
  PRIVATE,
  parseDecisionId,
  REPLY_HOLD_LABEL,
  type RoomItem,
  mentionName,
  replaceMentions,
} from "@majhi/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowDown, FileText, Info } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EMOJI_FONT } from "@/components/agent-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { Menu } from "@/components/ui/menu";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/toast";
import { useSendDecision } from "@/features/decisions/use-send-decision";
import { Markdown } from "@/features/room/markdown";
import { useRoom } from "@/features/room/use-room";
import { useAgentIndex } from "@/lib/agent-index";
import { useAnswerLaneCard, useCaptainCommand, useWaitingOn } from "@/lib/captain-queries";
import {
  useChatHolder,
  useChatSend,
  useClients,
  useContacts,
  useDecideReply,
  useEditReply,
  useMakeTask,
  useMarkUs,
  useRetryReply,
  useSamePerson,
  useUndoMerge,
  useUnlinkChat,
  useWhoIs,
} from "@/lib/client-queries";
import { cn } from "@/lib/cn";
import { useDecisions } from "@/lib/decision-queries";
import { describeError } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { useOrgs } from "@/lib/studio-queries";
import { AppMark } from "./app-mark";
import { ChatSettingsSheet } from "./chat-settings";
import { kindLine } from "./clients-list";
import { mentionQuery, namesToTokens, type Person, roomPeople, tokensToNames } from "./mentions";

/** A text with each mention token shown as the person's name. */
function withNames(text: string, names: Record<string, string> | undefined, wrap = ""): string {
  return replaceMentions(text, (id) => `${wrap}@${mentionName(id, names)}${wrap}`);
}

type Of<T extends RoomItem["type"]> = Extract<RoomItem, { type: T }>;

const TONES = ["blue", "violet", "green", "amber", "pink"] as const;

/** The same person always gets the same color. */
function toneOf(seed: string): (typeof TONES)[number] {
  let n = 0;
  for (const ch of seed) n = (n * 31 + ch.charCodeAt(0)) % 997;
  return TONES[n % TONES.length] ?? "blue";
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function Initial({ name, seed, size = 24 }: { name: string; seed: string; size?: number }) {
  const tone = toneOf(seed);
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full text-sm font-semibold"
      style={{
        width: size,
        height: size,
        background: `color-mix(in srgb,var(--c-${tone}) 22%,transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb,var(--c-${tone}) 50%,transparent)`,
      }}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/** One client chat: who writes to the client, the conversation, held replies and the box that writes to the chat. */
export function ClientRoom({ taskId }: { taskId: string }) {
  const clients = useClients();
  const row = clients.data?.clients.find((c) => c.id === taskId);
  const room = useRoom(taskId);
  if (clients.isPending) return null;
  if (row === undefined) {
    return (
      <div className="m-auto max-w-[360px] text-center text-base text-fg-muted text-pretty">
        This chat is not linked to a workspace yet. Link it under New chats.
      </div>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <Header row={row} />
      <section aria-label="Client chat" className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 outline-none">
        <Log row={row} items={room.state.items} more={room.state.more} loadOlder={room.loadOlder} />
        {row.archived === true ? (
          <p className="shrink-0 text-center text-sm text-fg-faint">
            Unlinked. This history is read only. Link the{" "}
            {row.app === "slack" || row.kind === "channel" ? "channel" : "group"} again to talk in it.
          </p>
        ) : (
          <Box row={row} />
        )}
      </section>
    </div>
  );
}

function Header({ row }: { row: ClientRow }) {
  const orgs = useOrgs().data;
  const org = orgs?.find((o) => o.id === row.org);
  const toast = useToast();
  const holder = useChatHolder();
  const unlink = useUnlinkChat();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const set = (next: "captain" | "you") => {
    if (next === row.holder) return;
    holder.mutate(
      { room: row.id, holder: next },
      { onError: (error) => toast("Could not change it", { detail: describeError(error), tone: "error" }) },
    );
  };
  return (
    <header
      title={`Chat ${row.id}`}
      className={cn("flex shrink-0 items-center gap-3 rounded-2xl px-4 py-2.5", GLASS)}
    >
      <AppMark app={row.app} size={32} />
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 className="min-w-0 truncate text-md font-semibold">{row.title}</h1>
        <div className="flex min-w-0 items-center gap-2 text-xs text-fg-faint">
          <span className="shrink-0">{kindLine(row)}</span>
          <span className="min-w-0 truncate">
            {org?.name}
            {row.people !== undefined && row.people > 0 ? ` · ${row.people} people` : ""}
          </span>
        </div>
      </div>
      {row.archived !== true && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-fg-faint">Replies</span>
          <Segmented
            label="Who replies"
            value={row.holder}
            segments={[
              { value: "captain", label: "Captain" },
              { value: "you", label: "You" },
            ]}
            onChange={(h) => {
              if (!holder.isPending) set(h);
            }}
          />
          <Menu
            label="Chat actions"
            items={[
              { label: "Chat settings", onSelect: () => setSettingsOpen(true) },
              {
                label: "Unlink",
                disabled: unlink.isPending,
                onSelect: () =>
                  unlink.mutate(
                    { room: row.id },
                    {
                      onError: (error) =>
                        toast("Could not unlink", { detail: describeError(error), tone: "error" }),
                    },
                  ),
              },
            ]}
          />
        </div>
      )}
      {row.archived === true && <span className="shrink-0 text-xs text-fg-faint">Unlinked</span>}
      {settingsOpen && (
        <ChatSettingsSheet room={row.id} orgName={org?.name ?? ""} onClose={() => setSettingsOpen(false)} />
      )}
    </header>
  );
}

function Log({
  row,
  items,
  more,
  loadOlder,
}: {
  row: ClientRow;
  items: readonly RoomItem[];
  more: boolean;
  loadOlder: () => Promise<void>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const shown = useMemo(() => items.filter(visible), [items]);
  const contacts = useContacts(row.org);
  const people = useMemo(() => roomPeople(items, contacts.data), [items, contacts.data]);
  const replies = useMemo(() => {
    const byDraft = new Map<number, Of<"client-reply">>();
    for (const item of items)
      if (item.type === "client-reply" && item.draft !== undefined) byDraft.set(item.draft, item);
    return byDraft;
  }, [items]);
  const last = shown.at(-1)?.id;
  const count = shown.length;
  // Follows the newest message while the owner is at the bottom; else offers a way back down.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the newest message and the count are the trigger
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    if (pinned.current) el.scrollTop = el.scrollHeight;
    else setUnseen(true);
  }, [last, count]);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        role="log"
        aria-label="Room messages"
        aria-live="off"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling log is reached with the keyboard
        tabIndex={0}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (pinned.current) setUnseen(false);
        }}
        className="scroll-fade flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto pt-1 pb-6 pl-0.5 focus-visible:outline-none"
      >
        {more && (
          <Button variant="ghost" size="sm" className="self-center" onClick={() => void loadOlder()}>
            Show earlier
          </Button>
        )}
        <ol className="m-0 mt-auto flex w-full max-w-[920px] flex-col p-0">
          {shown.map((item, i) => (
            <Row
              key={item.id}
              item={item}
              row={row}
              previous={shown[i - 1]}
              people={people}
              replies={replies}
            />
          ))}
        </ol>
      </div>
      {unseen && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute right-3 bottom-2 shadow-pop"
          onClick={() => {
            const el = scroller.current;
            if (el !== null) el.scrollTop = el.scrollHeight;
          }}
        >
          <ArrowDown aria-hidden="true" />
          New messages
        </Button>
      )}
    </div>
  );
}

/** The item types a client room draws. A discarded reply is not drawn. */
function visible(item: RoomItem): boolean {
  switch (item.type) {
    case "client":
    case "client-gap":
    case "same-person":
    case "who-is":
      return true;
    case "client-reply":
      return item.state !== "discarded";
    case "system":
      return item.level !== "error" || item.text !== "";
    default:
      return false;
  }
}

function Row({
  item,
  row,
  previous,
  people,
  replies,
}: {
  item: RoomItem;
  row: ClientRow;
  previous: RoomItem | undefined;
  people: readonly Person[];
  replies: ReadonlyMap<number, Of<"client-reply">>;
}) {
  switch (item.type) {
    case "client":
      return (
        <li className="mt-4 list-none">
          <Message item={item} row={row} replies={replies} />
        </li>
      );
    case "client-reply":
      return item.state === "held" ? (
        <li className="mt-3 list-none pl-[34px]">
          <HeldReply item={item} people={people} />
        </li>
      ) : (
        <li className="mt-4 list-none">
          <Reply item={item} row={row} />
        </li>
      );
    case "same-person":
      return (
        <li className="mt-3 list-none pl-[34px]">
          <SamePerson item={item} />
        </li>
      );
    case "who-is":
      return (
        <li className="mt-3 list-none pl-[34px]">
          <WhoIs item={item} />
        </li>
      );
    case "client-gap":
      return (
        <li className="mt-3 flex list-none items-center gap-2 pl-[34px] text-sm text-fg-muted">
          <Info aria-hidden="true" className="size-3.5 shrink-0" />
          {`Messages are missing from ${new Date(item.from).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })}`}
        </li>
      );
    case "system":
      return (
        <li
          className={cn(
            "flex list-none items-center gap-2 pl-[34px] text-sm",
            previous?.type === "system" ? "mt-1" : "mt-3",
            item.level === "info" ? "text-fg-muted" : "text-amber",
          )}
        >
          <Info aria-hidden="true" className="size-3.5 shrink-0" />
          {item.text}
        </li>
      );
    default:
      return null;
  }
}

/** The one faint line under a client message: what became of it, read from the message and the reply it led to. */
function outcomeText(outcome: ClientOutcome, reply: Of<"client-reply"> | undefined): string {
  if (outcome.state === "working") return "Working on it";
  if (reply !== undefined) {
    switch (reply.state) {
      case "sent":
        return "Replied";
      case "held":
        return `Waits for you: ${reply.hold === undefined ? "the reply is held" : REPLY_HOLD_LABEL[reply.hold]}`;
      case "failed": {
        // The gate marks who sent it ("Auto: ..."); the owner reads only the reason.
        const result = reply.result ?? "It did not go.";
        return `Can't reply: ${result.startsWith("Auto: ") ? result.slice(6) : result}`;
      }
      case "discarded":
        return "Reply discarded";
    }
  }
  const why = outcome.why === undefined ? "" : `: ${outcome.why}`;
  switch (outcome.state) {
    case "replied":
      return "Replied";
    case "ignored":
      return `Ignored${why}`;
    case "waits":
      return `Waits for you${why}`;
    case "failed":
      return `Can't reply${why}`;
    case "handled":
      return outcome.why ?? "Handled";
    case "skipped":
      return outcome.why ?? "Not read";
  }
}

/** The same card Needs you shows ("Captain blocked: no account"), here under the waiting message with its Pick buttons. */
function NoAccountLine({ org }: { org: string }) {
  const decision = useDecisions().data?.decisions.find((d) => d.id === captainPayDecisionId(org));
  const { send, busy } = useSendDecision();
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-fg-faint">
      <span>Captain blocked: no account</span>
      {decision?.options.map((o) => (
        <Button
          key={o.id}
          size="sm"
          variant={o.primary === true ? "primary" : "secondary"}
          disabled={busy}
          onClick={() => send(decision, o.id)}
        >
          {o.label}
        </Button>
      ))}
      {(decision === undefined || decision.options.length === 0) && (
        <Link to={PAGE_PATH.today} className="underline hover:text-fg">
          Choose the account
        </Link>
      )}
    </span>
  );
}

/**
 * What a message waiting on the captain waits on, with the button that unblocks it: the card in the captain's
 * lane (Allow or Deny answers that card), no account that may pay (a link to the account card in Needs you), or Stop everything
 * (Resume). Read from the captain's status, nothing stored. Nothing in the way: the plain "Working on it".
 */
function WaitingLine({ org }: { org: string }) {
  const toast = useToast();
  const status = useWaitingOn(org).data;
  const answer = useAnswerLaneCard();
  const resume = useCaptainCommand("captain.resume");
  const blocker = status?.orgs[0]?.blocker;
  const fail = (title: string) => (error: unknown) =>
    toast(title, { detail: describeError(error), tone: "error" });
  if (status?.stopped === true) {
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs text-fg-faint">
        Waiting: Stop everything is on
        <Button
          size="sm"
          variant="secondary"
          disabled={resume.isPending}
          onClick={() =>
            resume.mutate(
              { input: {}, reason: "Owner resumed the captain" },
              { onError: fail("Could not resume") },
            )
          }
        >
          Resume
        </Button>
      </span>
    );
  }
  if (blocker?.kind === "permission") {
    const pick = (option: string) =>
      answer.mutate(
        { task: blocker.task, item: blocker.item, option },
        { onError: fail("Could not answer") },
      );
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-fg-faint">
        <span className="min-w-0 truncate">
          The captain is waiting for your OK on <code className="font-mono">{blocker.title}</code>
        </span>
        <Button size="sm" variant="primary" disabled={answer.isPending} onClick={() => pick(blocker.allow)}>
          Allow
        </Button>
        <Button size="sm" variant="secondary" disabled={answer.isPending} onClick={() => pick(blocker.deny)}>
          Deny
        </Button>
      </span>
    );
  }
  if (blocker?.kind === "account") return <NoAccountLine org={org} />;
  return <span className="text-xs text-fg-faint">Working on it</span>;
}

/** The faint line under a message. A task or incident it became is a link. */
function OutcomeLine({
  outcome,
  reply,
  org,
}: {
  outcome: ClientOutcome;
  reply: Of<"client-reply"> | undefined;
  org: string;
}) {
  if (outcome.state === "working") return <WaitingLine org={org} />;
  const text = outcomeText(outcome, reply);
  const task = outcome.task;
  if (outcome.decision !== undefined && reply === undefined) {
    // The captain has no account to run on: the same card as Needs you, with its buttons, right here.
    if (parseDecisionId(outcome.decision)?.kind === "cpay") return <NoAccountLine org={org} />;
    return (
      <Link
        to="/decisions"
        search={{ id: outcome.decision }}
        className="text-xs text-fg-faint underline hover:text-fg"
      >
        {text}
      </Link>
    );
  }
  const at = task === undefined ? -1 : text.indexOf(task);
  if (task === undefined || at === -1) return <span className="text-xs text-fg-faint">{text}</span>;
  return (
    <span className="text-xs text-fg-faint">
      {text.slice(0, at)}
      <Link to="/t/$taskId" params={{ taskId: task }} className="underline hover:text-fg">
        {task}
      </Link>
      {text.slice(at + task.length)}
    </span>
  );
}

function Message({
  item,
  row,
  replies,
}: {
  item: Of<"client">;
  row: ClientRow;
  replies: ReadonlyMap<number, Of<"client-reply">>;
}) {
  const name = item.sender.name === "" ? "Unknown" : item.sender.name;
  return (
    <article className="group flex gap-2.5">
      <Initial name={name} seed={item.sender.id} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex h-6 min-w-0 items-center gap-2">
          <SenderName item={item} name={name} />
          <span className="shrink-0 font-mono text-xs text-fg-dim">{clock(item.sentAt ?? item.at)}</span>
          {item.us !== true && item.outcome?.task === undefined && (
            <MakeTask room={item.task} item={item.id} />
          )}
          {item.sender.verified ? null : <Badge>unverified</Badge>}
          {item.forwarded === true && <span className="shrink-0 text-xs text-fg-faint">forwarded</span>}
          {item.early === true && <span className="shrink-0 text-xs text-fg-faint">before the link</span>}
          {item.revisions.length > 0 && (
            <span
              className="shrink-0 text-xs text-fg-faint"
              title={item.revisions.map((r) => r.text).join("\n")}
            >
              edited
            </span>
          )}
        </div>
        {item.deleted === true && <span className="text-xs text-fg-faint">Deleted by the sender</span>}
        {item.text !== "" && (
          <div className="max-w-[72ch] whitespace-pre-wrap text-base text-fg">
            {withNames(item.text, item.mentions)}
          </div>
        )}
        {item.files.length > 0 && (
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {item.files.map((f) => (
              <FileChip key={f.id} file={f} />
            ))}
          </ul>
        )}
        {item.outcome !== undefined && (
          <OutcomeLine
            outcome={item.outcome}
            reply={item.outcome.draft === undefined ? undefined : replies.get(item.outcome.draft)}
            org={row.org ?? PRIVATE}
          />
        )}
      </div>
    </article>
  );
}

/** The sender's name. A verified sender's menu says whether they are one of us: the owner or a teammate. */
function SenderName({ item, name }: { item: Of<"client">; name: string }) {
  const toast = useToast();
  const mark = useMarkUs();
  if (!item.sender.verified) return <span className="shrink-0 text-base font-semibold text-fg">{name}</span>;
  const set = (us: boolean) =>
    mark.mutate(
      { room: item.task, item: item.id, us },
      { onError: (error) => toast("Could not mark it", { detail: describeError(error), tone: "error" }) },
    );
  return (
    <Menu
      label={`${name}`}
      align="left"
      items={[
        { label: "Mark as us", onSelect: () => set(true), checked: item.us === true },
        { label: "Not us", onSelect: () => set(false), checked: item.us !== true },
      ]}
      trigger={(props) => (
        <button
          type="button"
          {...props}
          title={`${name}`}
          className="shrink-0 cursor-pointer rounded-sm text-base font-semibold text-fg hover:text-accent-text"
        >
          {name}
        </button>
      )}
    />
  );
}

/** "Make a task": opens a task from this message through the captain's start path, then goes to it. */
function MakeTask({ room, item }: { room: string; item: string }) {
  const toast = useToast();
  const make = useMakeTask();
  const navigate = useNavigate();
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-5 px-1.5 text-xs text-fg-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
      disabled={make.isPending}
      onClick={() =>
        make.mutate(
          { room, item },
          {
            onSuccess: (made) => void navigate({ to: "/t/$taskId", params: { taskId: made.task } }),
            onError: (error) =>
              toast("Could not make a task", { detail: describeError(error), tone: "error" }),
          },
        )
      }
    >
      {make.isPending ? "Making..." : "Make a task"}
    </Button>
  );
}

function FileChip({ file }: { file: ChatFile }) {
  return (
    <li className="flex items-center gap-1.5 rounded-md border border-line bg-raised px-2 py-1 text-sm text-fg-soft">
      <FileText aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="max-w-[240px] truncate">{file.name}</span>
      {file.bytes !== undefined && (
        <span className="font-mono text-xs text-fg-faint">{formatBytes(file.bytes)}</span>
      )}
      {file.skipped !== undefined && <span className="text-xs text-amber">{file.skipped}</span>}
    </li>
  );
}

function Reply({ item, row }: { item: Of<"client-reply">; row: ClientRow }) {
  const toast = useToast();
  const retry = useRetryReply();
  const agents = useAgentIndex();
  const boss = [...agents.values()].find((a) => a.isBoss);
  const you = item.by === "you";
  return (
    <article className="group flex gap-2.5">
      {you ? (
        <Initial name="You" seed="you" />
      ) : (
        <span
          aria-hidden="true"
          className="inline-flex shrink-0 items-center justify-center rounded-full"
          style={{
            width: 24,
            height: 24,
            fontSize: 15,
            fontFamily: EMOJI_FONT,
            background: "color-mix(in srgb,var(--c-green) 24%,transparent)",
            boxShadow: "inset 0 0 0 1px color-mix(in srgb,var(--c-green) 55%,transparent)",
          }}
        >
          {boss?.emoji ?? "🧑‍✈️"}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex h-6 min-w-0 items-center gap-2">
          <span
            className={cn(
              "shrink-0 text-base font-semibold text-fg",
              !you && item.as !== "you" && "font-mono",
            )}
          >
            {you ? "You" : item.as === "you" ? "You (by the captain)" : `@${boss?.id ?? "captain"}`}
          </span>
          <span className="shrink-0 font-mono text-xs text-fg-dim">{clock(item.at)}</span>
          {item.by === "captain" && (item.state === "sent" || item.state === "failed") && (
            <MakeTask room={item.task} item={item.id} />
          )}
        </div>
        <div className="max-w-[72ch] text-base text-fg">
          <Markdown text={withNames(item.text, item.mentions, "**")} size="chat" />
        </div>
        {item.state === "sent" && (
          <Badge tone="green" className="self-start">
            Sent
          </Badge>
        )}
        {item.state === "failed" && (
          <span className="flex items-center gap-2">
            <Badge tone="red">Not sent</Badge>
            {item.result !== undefined && <span className="text-sm text-fg-muted">{item.result}</span>}
            <Button
              size="sm"
              variant="secondary"
              disabled={retry.isPending}
              onClick={() =>
                retry.mutate(
                  { room: item.task, item: item.id },
                  {
                    onError: (error) =>
                      toast("Could not send again", { detail: describeError(error), tone: "error" }),
                  },
                )
              }
            >
              {retry.isPending ? "Sending..." : "Retry"}
            </Button>
          </span>
        )}
      </div>
    </article>
  );
}

function HeldReply({ item, people }: { item: Of<"client-reply">; people: readonly Person[] }) {
  const toast = useToast();
  const decide = useDecideReply();
  const edit = useEditReply();
  const [editing, setEditing] = useState(false);
  // The owner edits names (`@Sara`); the saved text has the mention tokens back.
  const shownText = tokensToNames(item.text, people);
  const [draft, setDraft] = useState(shownText);
  const [caret, setCaret] = useState(0);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) setDraft(shownText);
  }, [shownText, editing]);
  const typing = editing ? mentionQuery(draft, caret) : undefined;
  const picks =
    typing === undefined
      ? []
      : people.filter((p) => p.name.toLowerCase().startsWith(typing.query.toLowerCase())).slice(0, 5);
  const pick = (person: Person) => {
    if (typing === undefined) return;
    const next = `${draft.slice(0, typing.at)}@${person.name} ${draft.slice(caret)}`;
    const at = typing.at + person.name.length + 2;
    setDraft(next);
    setCaret(at);
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(at, at);
    });
  };
  const id = item.draft;
  const fail = (title: string) => (error: unknown) =>
    toast(title, { detail: describeError(error), tone: "error" });
  const secret = item.hold === "secret";
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-amber-line bg-amber-wash px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Lamp state="needs" size={8} />
        <span className="font-medium text-fg">Reply waits for you</span>
        {item.hold !== undefined && (
          <span className="text-sm text-fg-muted">{REPLY_HOLD_LABEL[item.hold]}</span>
        )}
        <span className="flex-1" />
        {id !== undefined && !editing && (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={decide.isPending || secret}
              onClick={() => decide.mutate({ id, decision: "send" }, { onError: fail("Could not send") })}
            >
              Send
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={decide.isPending}
              onClick={() =>
                decide.mutate({ id, decision: "discard" }, { onError: fail("Could not discard") })
              }
            >
              Discard
            </Button>
          </>
        )}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            ref={field}
            aria-label="The reply"
            value={draft}
            rows={3}
            spellCheck={false}
            onChange={(event) => {
              setDraft(event.target.value);
              setCaret(event.target.selectionStart);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={(event) => {
              const first = picks[0];
              if (event.key === "Tab" && first !== undefined) {
                event.preventDefault();
                pick(first);
              }
            }}
            className="w-full resize-y rounded-md border border-line-control bg-field px-2.5 py-2 text-base text-fg focus-visible:border-accent focus-visible:outline-none"
          />
          {picks.length > 0 && (
            <div role="listbox" aria-label="People in this chat" className="flex flex-wrap gap-1.5">
              {picks.map((p) => (
                <Button
                  key={p.id}
                  size="sm"
                  variant="secondary"
                  role="option"
                  aria-selected={false}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(p)}
                >
                  @{p.name}
                </Button>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setDraft(shownText);
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={edit.isPending || draft.trim() === ""}
              onClick={() =>
                id !== undefined &&
                edit.mutate(
                  { draft: id, text: namesToTokens(draft.trim(), people) },
                  { onSuccess: () => setEditing(false), onError: fail("Could not save it") },
                )
              }
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="max-w-[72ch] text-base text-fg-soft">
          <Markdown text={withNames(item.text, item.mentions, "**")} size="chat" />
        </div>
      )}
    </section>
  );
}

/** Asked once in the chat: is a sender who looks like one of us (an admin) one of us, or a client. */
function WhoIs({ item }: { item: Of<"who-is"> }) {
  const toast = useToast();
  const answer = useWhoIs();
  const ask = (value: "us" | "client") =>
    answer.mutate(
      { room: item.task, item: item.id, answer: value },
      { onError: (error) => toast("Could not answer", { detail: describeError(error), tone: "error" }) },
    );
  return (
    <section className="flex w-fit max-w-full flex-wrap items-center gap-3 rounded-xl border border-line bg-raised px-3 py-2">
      <Initial name={item.name} seed={item.sender} />
      <span className="text-sm text-fg">{`Is ${item.name} one of us?`}</span>
      {item.state === "asking" ? (
        <>
          <Button size="sm" variant="secondary" disabled={answer.isPending} onClick={() => ask("us")}>
            Us
          </Button>
          <Button size="sm" variant="secondary" disabled={answer.isPending} onClick={() => ask("client")}>
            Client
          </Button>
        </>
      ) : (
        <span className="text-xs text-fg-faint">{item.state === "us" ? "Us" : "Client"}</span>
      )}
    </section>
  );
}

function SamePerson({ item }: { item: Of<"same-person"> }) {
  const toast = useToast();
  const answer = useSamePerson();
  const undo = useUndoMerge();
  const ask = (value: "same" | "not-same") =>
    answer.mutate(
      { room: item.task, item: item.id, answer: value },
      { onError: (error) => toast("Could not answer", { detail: describeError(error), tone: "error" }) },
    );
  const first = item.line.split(" ")[0] ?? "?";
  return (
    <section className="flex w-fit max-w-full flex-wrap items-center gap-3 rounded-xl border border-line bg-raised px-3 py-2">
      <Initial name={first} seed={item.a} />
      <span className="text-sm text-fg">{item.line}</span>
      {item.state === "asking" && (
        <>
          <Button size="sm" variant="secondary" disabled={answer.isPending} onClick={() => ask("same")}>
            Same
          </Button>
          <Button size="sm" variant="secondary" disabled={answer.isPending} onClick={() => ask("not-same")}>
            Not same
          </Button>
        </>
      )}
      {item.state === "same" && item.merge !== undefined && (
        <Button
          size="sm"
          variant="secondary"
          disabled={undo.isPending}
          onClick={() =>
            undo.mutate(
              { merge: item.merge as number },
              {
                onError: (error) => toast("Could not undo", { detail: describeError(error), tone: "error" }),
              },
            )
          }
        >
          Undo
        </Button>
      )}
      {item.state !== "asking" && (
        <span className="text-xs text-fg-faint">{item.state === "same" ? "Same" : "Not same"}</span>
      )}
    </section>
  );
}

/** The box that writes to the chat: Enter sends, Shift Enter makes a new line. */
function Box({ row }: { row: ClientRow }) {
  const toast = useToast();
  const send = useChatSend();
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const canSend = text.trim() !== "" && !send.isPending;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the text is the trigger for the box's height
  useLayoutEffect(() => {
    const el = field.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 186)}px`;
  }, [text]);
  function go() {
    if (!canSend) return;
    const sent = text;
    setText("");
    send.mutate(
      { room: row.id, text: sent },
      {
        onError: (error) => {
          setText((now) => (now === "" ? sent : now));
          toast("Could not send", { detail: describeError(error), tone: "error" });
        },
      },
    );
  }
  return (
    <div className="@container relative flex flex-col gap-1.5">
      <div className="flex flex-wrap items-end gap-1 rounded-xl border border-line-control bg-field p-1 transition-[border-color] duration-150 hover:border-line-hover has-[textarea:focus]:border-accent @[40rem]:flex-nowrap">
        <textarea
          ref={field}
          rows={1}
          value={text}
          aria-label="Message the chat"
          placeholder={`Write to ${row.title} on ${CHAT_APP_LABEL[row.app]}`}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              go();
            }
          }}
          className="order-first min-h-8 min-w-0 grow basis-full resize-none bg-transparent px-1.5 py-[5px] text-body text-fg outline-none placeholder:truncate placeholder:text-fg-faint @[40rem]:order-none @[40rem]:basis-0"
        />
        <div className="ml-auto flex min-w-0 items-end gap-1">
          <Button variant="primary" className="h-8 w-16 px-0" disabled={!canSend} onClick={go}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
