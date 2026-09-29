import { type ParsedTask, parseTaskText, type TaskKind } from "@majhi/shared";
import { useNavigate } from "@tanstack/react-router";
import { Paperclip } from "lucide-react";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useDeferredValue,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AttachmentChips } from "@/components/ui/attachment-chips";
import { Button } from "@/components/ui/button";
import { Menu } from "@/components/ui/menu";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { MOD_KEY } from "@/lib/format";
import { useAgents } from "@/lib/studio-queries";
import { useCreateTask, useProjects } from "@/lib/task-queries";
import { attachmentIds, filesFromClipboard, useAttachments } from "@/lib/use-attachments";
import {
  buildChips,
  type Chip,
  createOverrides,
  defaultAgentId,
  effectiveKind,
  eligibleAgents,
  taskBoxKey,
} from "./model";

const MAX_HEIGHT = 8 * 20 + 20;

const CHIP_TONE = {
  neutral: "border-line-control text-fg-soft",
  warn: "border-amber-line text-amber",
  blue: "border-blue-line text-blue",
} as const;

/** The parser runs on every keystroke and may not be built yet on the server side: never let it break the box. */
function tryParse(text: string, ctx: Parameters<typeof parseTaskText>[1]): ParsedTask | null {
  if (text.trim() === "") return null;
  try {
    return parseTaskText(text, ctx);
  } catch {
    return null;
  }
}

/** Write a task in plain words. Live chips show what majhi understood before anything starts. */
export function TaskBox() {
  const projects = useProjects().data;
  const agents = useAgents().data;
  const create = useCreateTask();
  const navigate = useNavigate();
  const toast = useToast();
  const attachments = useAttachments();
  const field = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [kindOverride, setKindOverride] = useState<TaskKind | undefined>();
  const [agentOverride, setAgentOverride] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  const deferred = useDeferredValue(text);

  const parsed = useMemo(
    () =>
      tryParse(deferred, {
        projects: projects ?? [],
        agents: (agents ?? []).flatMap((e) => (e.status === "ok" ? [{ id: e.agent.frontmatter.id }] : [])),
      }),
    [deferred, projects, agents],
  );
  const kind = effectiveKind(parsed, kindOverride);
  const chips = useMemo(
    () =>
      buildChips({
        parsed,
        projects: projects ?? [],
        agentOverride,
        defaultAgent: defaultAgentId(agents ?? [], parsed?.org, kind),
        kindOverride,
      }),
    [parsed, projects, agents, agentOverride, kindOverride, kind],
  );
  const choices = eligibleAgents(agents ?? [], parsed?.org);
  const shownAgent = chips.find((c) => c.id === "agent")?.label.slice(1);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resize whenever the text changes
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  const empty = text.trim() === "";
  const blocked = empty || attachments.uploading || create.isPending;

  function submit(start: boolean) {
    if (blocked) return;
    setFailure(undefined);
    create.mutate(
      {
        text,
        attachments: attachmentIds(attachments.items),
        start,
        ...createOverrides(parsed, kindOverride, agentOverride),
      },
      {
        onSuccess: (task) => {
          setText("");
          setKindOverride(undefined);
          setAgentOverride(undefined);
          attachments.clear();
          toast(start ? "Task started" : "Task saved", { detail: task.id });
          void navigate({ to: "/t/$taskId", params: { taskId: task.id } });
        },
        onError: (error) => setFailure([error.message, ...error.details].join(". ")),
      },
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (taskBoxKey(event.nativeEvent) === "start") {
      event.preventDefault();
      submit(true);
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = filesFromClipboard(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    attachments.add(files);
  }

  return (
    <div className="flex flex-col gap-2.5 border-b border-line p-3.5">
      <label htmlFor="new-task" className="sr-only">
        New task
      </label>
      <textarea
        ref={field}
        id="new-task"
        rows={3}
        value={text}
        placeholder="What needs doing? Name the repos, a base branch like from develop, @agents, paste links."
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className="max-h-[180px] min-h-[76px] w-full resize-none rounded-lg border border-line-control bg-field px-3 py-2.5 text-base leading-5 text-fg transition-[border-color] duration-150 placeholder:text-fg-faint hover:border-line-hover focus-visible:border-blue focus-visible:outline-none"
      />
      {(chips.length > 0 || attachments.items.length > 0) && (
        <div className="flex flex-col gap-1.5">
          {chips.length > 0 && (
            <ul aria-label="What majhi understood" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {chips.map((chip) => (
                <li key={chip.id}>
                  <ChipView
                    chip={chip}
                    agentChoices={choices.map((e) => e.agent.frontmatter.id)}
                    currentAgent={shownAgent}
                    onAgent={setAgentOverride}
                    onKind={() => setKindOverride(kind === "chat" ? "code" : "chat")}
                  />
                </li>
              ))}
            </ul>
          )}
          <AttachmentChips items={attachments.items} onRemove={attachments.remove} />
        </div>
      )}
      {failure && (
        <p
          role="alert"
          className="rounded-md border border-red-line bg-red-wash px-3 py-2 text-sm text-red text-pretty"
        >
          {failure}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button aria-label="Attach a file or image" onClick={() => fileInput.current?.click()}>
          <Paperclip aria-hidden="true" />
          Attach
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
        <Button variant="ghost" className="ml-auto" disabled={blocked} onClick={() => submit(false)}>
          Save for later
        </Button>
        <Button
          variant="primary"
          disabled={blocked}
          title={`Start (${MOD_KEY} Enter)`}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          onClick={() => submit(true)}
        >
          Start
        </Button>
      </div>
    </div>
  );
}

function ChipView({
  chip,
  agentChoices,
  currentAgent,
  onAgent,
  onKind,
}: {
  chip: Chip;
  agentChoices: readonly string[];
  currentAgent: string | undefined;
  onAgent: (id: string) => void;
  onKind: () => void;
}) {
  const base = cn("flex h-6 items-center rounded-sm border px-2 font-mono text-xs", CHIP_TONE[chip.tone]);
  if (chip.action === "kind") {
    return (
      <button
        type="button"
        title={chip.title}
        aria-label={`Kind: ${chip.label}. Click to switch`}
        onClick={onKind}
        className={cn(base, "cursor-pointer hover:border-line-hover hover:bg-raised")}
      >
        {chip.label}
      </button>
    );
  }
  if (chip.action === "agent") {
    return (
      <Menu
        label="Choose the agent"
        align="left"
        items={agentChoices.map((id) => ({
          label: `@${id}`,
          checked: id === currentAgent,
          onSelect: () => onAgent(id),
        }))}
        trigger={({ ref, ...props }) => (
          <button
            ref={ref}
            type="button"
            title={chip.title}
            aria-label={`Agent: ${chip.label}. Click to change`}
            {...props}
            className={cn(base, "cursor-pointer hover:bg-raised")}
          >
            {chip.label}
          </button>
        )}
      />
    );
  }
  return (
    <span className={base} title={chip.title}>
      {chip.label}
    </span>
  );
}
