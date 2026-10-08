import type { AgentLive, RoomItem } from "@majhi/shared";
import { ATTACHMENT_ACCEPT, canWorkIn, type Task } from "@majhi/shared";
import { KeyRound, Paperclip } from "lucide-react";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EMOJI_FONT } from "@/components/agent-avatar";
import { AttachmentChips, DropHint } from "@/components/ui/attachment-chips";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { looksLikeSecret, SECRET_WARNING } from "@/features/boss/model";
import { type AgentInfo, useAgentIndex } from "@/lib/agent-index";
import { cmd } from "@/lib/api";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { MOD_KEY } from "@/lib/format";
import { useServerOffline } from "@/lib/queries";
import { useTask } from "@/lib/task-queries";
import { useTypingSignal } from "@/lib/typing-signal";
import { attachmentIds, filesFromClipboard, useAttachments, useFileDrop } from "@/lib/use-attachments";
import {
  addressedAgent,
  applyCompletion,
  composerKey,
  detectTrigger,
  filterCommands,
  isBusy,
  pendingOwnerItem,
  type Trigger,
} from "./model";
import { ModelPicker } from "./model-picker";

interface PopupOption {
  key: string;
  insert: string;
  label: string;
  /** An agent's emoji, before the label. */
  emoji?: string | undefined;
  note?: string | undefined;
}

/** About eight lines of 22px text plus the field's padding. */
const MAX_HEIGHT = 8 * 22 + 10;
/** Numbers the messages shown before the server stored them. */
let pendingCount = 0;

/** Agents a mention can name: the team first, then the org's agents who may join. Captain excluded. */
function agentMatches(
  task: Pick<Task, "org" | "team">,
  index: ReadonlyMap<string, AgentInfo>,
  query: string,
): { info: AgentInfo; onTeam: boolean }[] {
  const q = query.toLowerCase();
  const team = task.team.flatMap((id) => {
    const info = index.get(id);
    return info ? [{ info, onTeam: true }] : [];
  });
  const others = [...index.values()]
    .filter((a) => !a.isBoss && !task.team.includes(a.id) && canWorkIn(a, task.org))
    .map((info) => ({ info, onTeam: false }));
  return [...team, ...others].filter((a) => a.info.id.includes(q)).slice(0, 8);
}

/** The message box: Enter sends, `/` lists the agent's commands, `@` agents and files, Esc stops the agent. */
export function Composer({
  taskId,
  agents,
  onSent,
  onDrop,
  onCancel,
  cancelling,
  starting = false,
  draft,
}: {
  taskId: string;
  agents: readonly AgentLive[];
  /** Puts an item in the room: the message as sent at once, then the stored one. */
  onSent: (item: RoomItem) => void;
  /** Takes the message shown at once out again, when the stored one replaces it or sending failed. */
  onDrop: (id: string) => void;
  onCancel: () => void;
  cancelling: boolean;
  /** The task is set up but no agent has reported yet. */
  starting?: boolean;
  /** Text a card button puts in the box, like "@lead ". A new `n` applies it again. */
  draft?: { text: string; n: number } | undefined;
}) {
  const toast = useToast();
  const field = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const listId = useId();
  const attachments = useAttachments();
  const { dragging, dropProps } = useFileDrop(attachments.add);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  // A room that opens with nothing focused (from the new-task dialog, or a page load) gets the box.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const now = document.activeElement;
      if (now === null || now === document.body) field.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  useTypingSignal(taskId, focused && text.trim() !== "");

  const secretInText = useMemo(() => looksLikeSecret(text), [text]);
  const busy = isBusy(agents) || starting;
  const offline = useServerOffline();
  const commands = agents[0]?.commands ?? [];
  const trigger = detectTrigger(text, caret);
  const popupTrigger = trigger && trigger.start !== dismissed ? trigger : null;
  const files = useFileSearch(taskId, popupTrigger?.kind === "mention" ? popupTrigger.query : null);
  const task = useTask(taskId).data;
  const index = useAgentIndex();
  const mentionable =
    popupTrigger?.kind === "mention" && task ? agentMatches(task, index, popupTrigger.query) : [];

  const options: PopupOption[] =
    popupTrigger?.kind === "slash"
      ? filterCommands(commands, popupTrigger.query).map((c) => ({
          key: c.name,
          insert: c.name,
          label: `/${c.name}`,
          note: c.description,
        }))
      : popupTrigger?.kind === "mention"
        ? [
            // Agents first: the task's team, then the org's other agents, who join when mentioned.
            ...mentionable.map((a) => ({
              key: `agent:${a.info.id}`,
              insert: a.info.id,
              label: `@${a.info.id}`,
              emoji: a.info.emoji,
              note: `${a.info.role} · ${a.info.account}${a.onTeam ? "" : " · joins the task"}`,
            })),
            ...files.map((f) => ({
              key: `${f.repo}:${f.path}`,
              insert: f.path,
              label: f.path,
              note: f.repo === "task" ? "task folder" : f.repo === "project" ? "project" : f.repo,
            })),
          ]
        : [];
  const popupOpen = popupTrigger !== null;
  const emptyNote =
    popupTrigger?.kind === "slash"
      ? commands.length === 0
        ? "No commands yet. They show once the agent has started."
        : "No command matches."
      : "No agents or files match.";
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));

  const hasContent = text.trim() !== "" || attachmentIds(attachments.items).length > 0;
  const canSend = hasContent && !attachments.uploading;
  const addressed = task ? addressedAgent(text, task.team) : undefined;
  // On a task's page the captain is the default recipient; an @mention of an agent still addresses that agent.
  const toCaptain =
    task !== undefined &&
    task.kind !== "chat" &&
    addressed === undefined &&
    [...index.values()].some((a) => a.isBoss);
  // One action in one place: Stop while the agent works and the box is empty, else Send.
  const stops = busy && !hasContent;

  /** Shows the message and clears the box at once; the server stores it and starts the agent after. */
  function send(mode: "queue" | "interrupt") {
    if (!canSend) return;
    // Nothing would arrive: say so and keep the message in the box instead of showing it as sent.
    if (offline) {
      toast("majhi is offline", { detail: "Your message was not sent. It stays here.", tone: "error" });
      return;
    }
    const sentText = text;
    const sentFiles = attachments.items;
    pendingCount += 1;
    const pending = pendingOwnerItem(
      taskId,
      sentText,
      sentFiles.flatMap((f) => (f.attachment ? [f.attachment] : [])),
      pendingCount,
    );
    onSent(pending);
    setText("");
    setCaret(0);
    attachments.clear();
    const body = { task: taskId, text: sentText, attachments: attachmentIds(sentFiles), mode };
    // A message with files goes to the lead as before: the captain's lane takes words only.
    const toLane = toCaptain && sentFiles.length === 0;
    cmd("room.send", toLane ? { ...body, to: "captain" as const } : body).then(
      ({ item }) => {
        onDrop(pending.id);
        onSent(item);
      },
      (error: unknown) => {
        onDrop(pending.id);
        // Put the message back for another try, unless the owner already wrote something new.
        setText((current) => (current === "" ? sentText : current));
        attachments.restore(sentFiles);
        toast("Could not send", { detail: describeError(error), tone: "error" });
      },
    );
  }

  // Grow with the text, up to about eight lines.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resize whenever the text changes
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  // A card's Reply or Ask for changes: address the agent, keep what was typed, and focus the box.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per click, keyed by its number
  useEffect(() => {
    if (draft === undefined) return;
    const next = text.startsWith(draft.text) ? text : `${draft.text}${text}`;
    setText(next);
    setCaret(next.length);
    setDismissed(0);
    // At once, so a key pressed before the next frame is not lost to the page behind.
    field.current?.focus();
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(next.length, next.length);
    });
  }, [draft?.n]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the first option is active again whenever the query changes
  useEffect(() => setActive(0), [popupTrigger?.kind, popupTrigger?.query]);

  function choose(option: PopupOption, at: Trigger) {
    const done = applyCompletion(text, at, option.insert);
    setText(done.text);
    setCaret(done.caret);
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(done.caret, done.caret);
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (popupOpen && popupTrigger && options.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((activeIndex + step + options.length) % options.length);
        return;
      }
      if (
        (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.shiftKey) ||
        event.key === "Tab"
      ) {
        const option = options[activeIndex];
        if (option && !event.nativeEvent.isComposing) {
          event.preventDefault();
          choose(option, popupTrigger);
          return;
        }
      }
    }
    const action = composerKey(event.nativeEvent, {
      // An empty popup is only a hint: Enter still sends and Esc still stops the agent.
      popupOpen: popupTrigger !== null && popupOpen && options.length > 0,
      busy,
      hasContent,
    });
    switch (action) {
      case "close-popup":
        event.preventDefault();
        event.stopPropagation();
        if (popupTrigger) setDismissed(popupTrigger.start);
        break;
      case "send":
        event.preventDefault();
        send("queue");
        break;
      case "interrupt":
        event.preventDefault();
        send("interrupt");
        break;
      default:
        // Newline is the textarea's own; cancel is handled by the room around it.
        break;
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = filesFromClipboard(event.clipboardData);
    if (pasted.length === 0) return;
    event.preventDefault();
    attachments.add(pasted);
  }

  return (
    <div {...dropProps} className="@container relative flex flex-col gap-1.5">
      {dragging && <DropHint />}
      <AttachmentChips items={attachments.items} onRemove={attachments.remove} />
      {secretInText && (
        <p
          role="status"
          className="flex items-center gap-1.5 rounded-md border border-amber-line bg-amber-wash px-2.5 py-1 text-sm text-amber"
        >
          <KeyRound aria-hidden="true" className="size-3.5 shrink-0" />
          {SECRET_WARNING}
        </p>
      )}
      <div className="relative">
        {popupOpen && popupTrigger && (
          <div
            id={listId}
            role="listbox"
            aria-label={popupTrigger.kind === "slash" ? "Slash commands" : "Files"}
            className="absolute right-0 bottom-full left-0 z-20 mb-1.5 max-h-56 overflow-auto rounded-lg border border-line-bright bg-glass-strong p-1 shadow-pop"
          >
            {options.length === 0 && <p className="px-2.5 py-1.5 text-sm text-fg-faint">{emptyNote}</p>}
            {options.map((option, i) => (
              <div
                key={option.key}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                tabIndex={-1}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(option, popupTrigger);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex cursor-pointer items-baseline gap-2 rounded-sm px-2.5 py-1.5",
                  i === activeIndex && "bg-selected",
                )}
              >
                {option.emoji && (
                  <span aria-hidden="true" className="shrink-0 text-sm" style={{ fontFamily: EMOJI_FONT }}>
                    {option.emoji}
                  </span>
                )}
                <span className="min-w-0 truncate font-mono text-sm text-fg">{option.label}</span>
                {option.note && <span className="ml-auto truncate text-xs text-fg-faint">{option.note}</span>}
              </div>
            ))}
          </div>
        )}
        {/* Narrower than 40rem (the captain drawer, a split room), the text takes the whole first row and
            the buttons sit under it; the model picker and Send left it a column one word wide. */}
        <div className="flex flex-wrap items-end gap-1 rounded-xl border border-line-control bg-field p-1 transition-[border-color] duration-150 hover:border-line-hover has-[textarea:focus]:border-accent @[40rem]:flex-nowrap">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Attach a file or image"
            title="Attach a file or image"
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip aria-hidden="true" />
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            hidden
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => {
              attachments.add(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <textarea
            ref={field}
            rows={1}
            value={text}
            aria-label="Message the room"
            aria-autocomplete={popupOpen ? "list" : undefined}
            aria-controls={popupOpen ? listId : undefined}
            aria-activedescendant={popupOpen ? `${listId}-${activeIndex}` : undefined}
            placeholder={
              toCaptain
                ? "Message the captain about this task"
                : focused
                  ? busy
                    ? "Enter queues, Shift Enter new line, Esc stops"
                    : "Enter sends, Shift Enter new line, @ mention, / commands"
                  : task?.kind === "chat" && addressed
                    ? `Message @${addressed}`
                    : "Talk to the room"
            }
            spellCheck={false}
            onChange={(event) => {
              setText(event.target.value);
              setCaret(event.target.selectionStart);
              setDismissed(null);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            style={{ maxHeight: MAX_HEIGHT }}
            className="order-first min-h-8 min-w-0 grow basis-full resize-none bg-transparent px-1.5 py-[5px] text-body text-fg outline-none placeholder:truncate placeholder:text-fg-faint @[40rem]:order-none @[40rem]:basis-0"
          />
          <div className="ml-auto flex min-w-0 items-end gap-1">
            {task && addressed && <ModelPicker task={task} agent={addressed} />}
            {stops ? (
              <Button
                variant="secondary"
                className={cancelling ? "h-8 w-[5.5rem] px-0" : "h-8 w-16 px-0"}
                disabled={cancelling}
                onClick={onCancel}
                title="Stop this turn (Esc)"
              >
                {cancelling ? "Stopping..." : "Stop"}
              </Button>
            ) : (
              <Button
                variant="primary"
                className="h-8 w-16 px-0"
                disabled={!canSend}
                onClick={() => send("queue")}
                title={
                  busy
                    ? `Queue for the next turn. ${MOD_KEY} Enter stops the agent and sends now.`
                    : undefined
                }
              >
                Send
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** File paths for an `@` query, searched 150 ms after typing stops. `null` turns the search off. */
function useFileSearch(taskId: string, query: string | null): { path: string; repo: string }[] {
  const [found, setFound] = useState<{ path: string; repo: string }[]>([]);
  useEffect(() => {
    if (query === null) {
      setFound([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      cmd("room.files", { task: taskId, query }).then(
        (result) => {
          if (!cancelled) setFound(result.slice(0, 30));
        },
        () => {
          if (!cancelled) setFound([]);
        },
      );
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [taskId, query]);
  return found;
}
