import type { AgentLive, RoomItem } from "@majhi/shared";
import { useMutation } from "@tanstack/react-query";
import { KeyRound, Paperclip, Square } from "lucide-react";
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
import { AttachmentChips } from "@/components/ui/attachment-chips";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { useToast } from "@/components/ui/toast";
import { looksLikeSecret, SECRET_WARNING } from "@/features/boss/model";
import { type ApiRequestError, cmd } from "@/lib/api";
import { cn } from "@/lib/cn";
import { MOD_KEY } from "@/lib/format";
import { attachmentIds, filesFromClipboard, useAttachments } from "@/lib/use-attachments";
import {
  applyCompletion,
  composerKey,
  detectTrigger,
  filterCommands,
  isBusy,
  isWorking,
  type Trigger,
} from "./model";

interface PopupOption {
  key: string;
  insert: string;
  label: string;
  note?: string | undefined;
}

const MAX_HEIGHT = 8 * 20 + 16;

/** The message box: Enter sends, `/` lists the agent's commands, `@` finds files, Esc stops the agent. */
export function Composer({
  taskId,
  agents,
  onSent,
  onCancel,
  cancelling,
}: {
  taskId: string;
  agents: readonly AgentLive[];
  onSent: (item: RoomItem) => void;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const toast = useToast();
  const field = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const listId = useId();
  const attachments = useAttachments();
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);

  const secretInText = useMemo(() => looksLikeSecret(text), [text]);
  const busy = isBusy(agents);
  const working = agents.some((a) => isWorking(a));
  const commands = agents[0]?.commands ?? [];
  const trigger = detectTrigger(text, caret);
  const popupTrigger = trigger && trigger.start !== dismissed ? trigger : null;
  const files = useFileSearch(taskId, popupTrigger?.kind === "mention" ? popupTrigger.query : null);

  const options: PopupOption[] =
    popupTrigger?.kind === "slash"
      ? filterCommands(commands, popupTrigger.query).map((c) => ({
          key: c.name,
          insert: c.name,
          label: `/${c.name}`,
          note: c.description,
        }))
      : popupTrigger?.kind === "mention"
        ? files.map((f) => ({
            key: `${f.repo}:${f.path}`,
            insert: f.path,
            label: f.path,
            note: f.repo === "task" ? "task folder" : f.repo === "project" ? "project" : f.repo,
          }))
        : [];
  const popupOpen = popupTrigger !== null;
  const emptyNote =
    popupTrigger?.kind === "slash"
      ? commands.length === 0
        ? "No commands yet. They show once the agent has started."
        : "No command matches."
      : "No files match.";
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));

  const send = useMutation<{ item: RoomItem }, ApiRequestError, "queue" | "interrupt">({
    mutationFn: (mode) =>
      cmd("room.send", { task: taskId, text, attachments: attachmentIds(attachments.items), mode }),
    onSuccess: ({ item }) => {
      onSent(item);
      setText("");
      setCaret(0);
      attachments.clear();
    },
    onError: (error) => toast("Could not send", { detail: error.message, tone: "error" }),
  });

  const hasContent = text.trim() !== "" || attachmentIds(attachments.items).length > 0;
  const canSend = hasContent && !attachments.uploading && !send.isPending;

  // Grow with the text, up to about eight lines.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resize whenever the text changes
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

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
        if (canSend) send.mutate("queue");
        break;
      case "interrupt":
        event.preventDefault();
        if (canSend) send.mutate("interrupt");
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
    <div className="flex flex-col gap-1.5">
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
            className="absolute right-0 bottom-full left-0 z-20 mb-1.5 max-h-56 overflow-auto rounded-lg border border-line-bright bg-card p-1 shadow-pop"
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
                <span className="min-w-0 truncate font-mono text-sm text-fg">{option.label}</span>
                {option.note && <span className="ml-auto truncate text-xs text-fg-faint">{option.note}</span>}
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-[10px] border border-line-control bg-field p-1 transition-[border-color] duration-150 hover:border-line-hover focus-within:border-blue">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Attach a file or image"
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip aria-hidden="true" />
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
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
            placeholder="Talk to the room. / for commands, @ for files."
            spellCheck={false}
            onChange={(event) => {
              setText(event.target.value);
              setCaret(event.target.selectionStart);
              setDismissed(null);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            className="max-h-[176px] min-h-[34px] min-w-0 flex-1 resize-none bg-transparent px-1 py-[7px] text-body text-fg outline-none placeholder:text-fg-faint"
          />
          {working && (
            <Button variant="secondary" disabled={cancelling} onClick={onCancel} title="Stop this turn (Esc)">
              <Square aria-hidden="true" className="fill-current" />
              Stop
            </Button>
          )}
          {busy && hasContent && (
            <Button variant="secondary" disabled={!canSend} onClick={() => send.mutate("interrupt")}>
              Stop and send
            </Button>
          )}
          <Button
            variant="primary"
            size="lg"
            className="text-body"
            disabled={!canSend}
            onClick={() => send.mutate("queue")}
          >
            Send
          </Button>
        </div>
      </div>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-faint">
        <span>
          <Kbd>Enter</Kbd> {busy ? "queues" : "sends"}
        </span>
        <span>
          <Kbd>Shift Enter</Kbd> new line
        </span>
        {busy && (
          <span>
            <Kbd>{MOD_KEY} Enter</Kbd> stop and send
          </span>
        )}
        {working && (
          <span className="text-amber">
            <Kbd>Esc</Kbd> to stop
          </span>
        )}
      </p>
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
