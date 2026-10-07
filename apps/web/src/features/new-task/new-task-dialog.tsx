import {
  ATTACHMENT_ACCEPT,
  type ParsedTask,
  parseTaskText,
  TASK_TYPE_LABEL,
  TASK_TYPES,
  type TaskKind,
  type TaskType,
  taskKindOf,
} from "@majhi/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronDown, Lock, Paperclip, X } from "lucide-react";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AttachmentChips, DropHint } from "@/components/ui/attachment-chips";
import { Button } from "@/components/ui/button";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { Menu } from "@/components/ui/menu";
import { Modal } from "@/components/ui/modal";
import { OrgBadge } from "@/components/ui/org-badge";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useAgentIndex } from "@/lib/agent-index";
import { cn } from "@/lib/cn";
import { MOD_KEY } from "@/lib/format";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { useAgents, useOrgs } from "@/lib/studio-queries";
import { useCreateTask, useProjects, useTasks } from "@/lib/task-queries";
import { attachmentIds, filesFromClipboard, useAttachments, useFileDrop } from "@/lib/use-attachments";
import { defaultAgentId, eligibleAgents } from "../tasks/model";
import {
  baseFields,
  canAdd,
  groupProjects,
  initialProjects,
  linkChoices,
  linkFields,
  namedProjects,
  togglePicked,
  typedText,
  workspaceConflict,
} from "./model";
import { TaskChips } from "./task-chips";

/** The parser runs on every keystroke and must never break the dialog. */
function tryParse(text: string, ctx: Parameters<typeof parseTaskText>[1]): ParsedTask | null {
  if (text.trim() === "") return null;
  try {
    return parseTaskText(text, ctx);
  } catch {
    return null;
  }
}

const KINDS: readonly { id: TaskKind; hint: string }[] = [
  { id: "code", hint: "Changes a project: worktree, branch, review, ship." },
  {
    id: "ops",
    hint: "Investigates with the workspace's connections and writes a report. Projects are read only.",
  },
  { id: "chat", hint: "One agent, no project." },
];

/** The type picker's first choice: majhi reads the type from the words. */
const AUTO_TYPE = "auto";

/** A code task needs a project, a chat task has none. An ops task may have either. */
function kindFits(kind: TaskKind, projects: number): boolean {
  return kind === "ops" || (kind === "code") === projects > 0;
}

const FIELD =
  "w-full rounded-[10px] border border-line-control bg-field text-fg transition-[border-color] duration-150 hover:border-line-hover focus-visible:border-accent focus-visible:outline-none";

export function NewTaskDialog({ onClose, project }: { onClose: () => void; project?: string }) {
  const { org: filterOrg } = useOrgFilter();
  const orgs = useOrgs().data ?? [];
  const projects = useProjects();
  const agents = useAgents().data;
  const agentIndex = useAgentIndex();
  const roleOf = (id: string) => agentIndex.get(id)?.role ?? "Agent";
  const create = useCreateTask();
  const openTasks = useTasks().data;
  const navigate = useNavigate();
  const toast = useToast();
  const attachments = useAttachments();
  const { dragging, dropProps } = useFileDrop(attachments.add);
  const titleField = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  // Protected projects the owner lets agents write in for this task. Off: read-only.
  const [writes, setWrites] = useState<string[]>([]);
  // A base branch typed per repo. Empty: the project's own base.
  const [bases, setBases] = useState<Record<string, string>>({});
  const [kindPick, setKindPick] = useState<TaskKind | undefined>();
  const [typePick, setTypePick] = useState<TaskType | undefined>();
  const [sendingStart, setSendingStart] = useState<boolean | undefined>();
  const [agentOverride, setAgentOverride] = useState<string | undefined>();
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [parent, setParent] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | undefined>();
  const seeded = useRef(false);
  // One id per dialog session: the server returns the first task for a repeated id, so a double
  // press makes one task. `sending` closes the gap before the next render shows the pending state.
  const requestId = useRef(crypto.randomUUID());
  const sending = useRef(false);

  // The org filter preselects its only project, once the projects have loaded.
  useEffect(() => {
    if (seeded.current || !projects.data) return;
    seeded.current = true;
    setPicked(project === undefined ? initialProjects(projects.data, filterOrg) : [project]);
  }, [projects.data, filterOrg, project]);

  // The dialog opens after this effect (Modal shows it), so focus waits a frame.
  useEffect(() => {
    const frame = requestAnimationFrame(() => titleField.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const draft = { title, details };
  const deferred = useDeferredValue(typedText(draft));
  const parseCtx = useMemo(
    () => ({
      projects: projects.data ?? [],
      agents: (agents ?? []).flatMap((e) => (e.status === "ok" ? [{ id: e.agent.frontmatter.id }] : [])),
    }),
    [projects.data, agents],
  );
  const parsed = useMemo(() => tryParse(deferred, parseCtx), [deferred, parseCtx]);
  const named = namedProjects(parsed);
  // Only the chips attach repos. Projects the words name are offered, never added by themselves.
  const chosen = picked;
  const mentioned = named.filter((id) => !chosen.includes(id));
  const chosenOrg = projects.data?.find((p) => chosen.includes(p.id))?.org ?? filterOrg;
  // The parser's warnings about the words (an unknown @agent). Repos come from the chips alone.
  const mixed = workspaceConflict(chosen, projects.data ?? [], orgs);
  const warnings = (parsed?.warnings ?? []).filter((w) => !w.startsWith("Repos from"));
  // The kind the words suggest for the chosen projects, until the owner picks one. A pick that no
  // longer fits the projects falls back.
  const inferred = taskKindOf(deferred, chosen.length > 0);
  const kind = kindPick !== undefined && kindFits(kindPick, chosen.length) ? kindPick : inferred;
  // Nothing typed and nothing picked: no kind is suggested yet.
  const kindShown = kindPick !== undefined || deferred.trim() !== "" || chosen.length > 0;
  const team = agentOverride ?? parsed?.mentions[0] ?? defaultAgentId(agents ?? [], chosenOrg, kind);
  const groups = groupProjects(projects.data ?? [], orgs, filterOrg);
  const choices = linkChoices(openTasks ?? [], filterOrg);
  const ready = canAdd(draft, attachments.uploading, create.isPending) && mixed === undefined;

  function submit(start: boolean) {
    if (!ready || sending.current) return;
    sending.current = true;
    setSendingStart(start);
    setFailure(undefined);
    create.mutate(
      {
        requestId: requestId.current,
        text: typedText(draft),
        repos: chosen.map((project) => ({
          project,
          ...baseFields(bases[project], projects.data?.find((p) => p.id === project)?.base),
          ...(writes.includes(project) ? { writes: true } : {}),
        })),
        attachments: attachmentIds(attachments.items),
        start,
        ...(kindPick !== undefined && kind === kindPick ? { kind } : {}),
        ...(typePick === undefined ? {} : { type: typePick }),
        ...linkFields(parent[0], dependsOn),
        ...(agentOverride ? { agent: agentOverride } : {}),
      },
      {
        onSuccess: (task) => {
          const open = () =>
            void navigate({ to: "/t/$taskId", params: { taskId: task.id }, search: orgSearch(filterOrg) });
          onClose();
          toast(
            start
              ? dependsOn.length > 0
                ? "Added, starts when ready"
                : "Task started"
              : "Added to the inbox",
            {
              detail: task.id,
            },
          );
          open();
        },
        onError: (error) => {
          sending.current = false;
          setSendingStart(undefined);
          setFailure([error.message, ...error.details].join(". "));
        },
      },
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    const field = event.target;
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      submit(true);
    } else if (field instanceof HTMLInputElement && field.id === "nt-title") {
      // A single-line field: Enter sends, like the other forms.
      event.preventDefault();
      submit(true);
    }
  }

  function onPaste(event: ClipboardEvent<HTMLElement>) {
    const files = filesFromClipboard(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    attachments.add(files);
  }

  const agentChoices = eligibleAgents(agents ?? [], chosenOrg).map((e) => e.agent.frontmatter.id);

  return (
    <Modal label="New task" onClose={onClose} className="w-[700px]">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the shortcut listens for keys bubbling from the fields */}
      <div onKeyDown={onKeyDown} {...dropProps} className="relative flex max-h-[calc(100dvh-32px)] flex-col">
        {dragging && <DropHint />}
        <div className="flex shrink-0 items-center gap-2.5 px-6 pt-[22px] pb-3">
          <h2 className="text-[18px] font-semibold">New task</h2>
          <Button
            variant="ghost"
            size="icon"
            className="-mr-2 ml-auto size-9"
            aria-label="Close"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="nt-title" className="text-sm text-fg-faint">
              Title
            </label>
            <input
              ref={titleField}
              id="nt-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onPaste={onPaste}
              placeholder="What should the team do?"
              spellCheck={false}
              autoComplete="off"
              className={cn(FIELD, "h-11 px-3.5 text-md placeholder:text-fg-faint")}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="nt-details" className="text-sm text-fg-faint">
              Details for the team
            </label>
            <textarea
              id="nt-details"
              rows={4}
              value={details}
              onChange={(event) => setDetails(event.target.value)}
              onPaste={onPaste}
              placeholder="Context, what done looks like, files to look at. The lead reads this first."
              spellCheck={false}
              className={cn(FIELD, "resize-y px-3.5 py-3 text-body leading-[1.5] placeholder:text-fg-faint")}
            />
            <AttachmentChips items={attachments.items} onRemove={attachments.remove} />
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm text-fg-faint">Team</span>
            {team ? (
              <Menu
                label="Choose the agent"
                align="left"
                items={agentChoices.map((id) => ({
                  label: `@${id} · ${roleOf(id)}`,
                  checked: id === team,
                  onSelect: () => setAgentOverride(id),
                }))}
                trigger={({ ref, ...props }) => (
                  <button
                    ref={ref}
                    type="button"
                    {...props}
                    aria-label={`Agent: @${team}. Click to change`}
                    className="flex h-8 w-fit cursor-pointer items-center gap-2 rounded-md border border-line-control bg-field px-2.5 text-sm text-fg hover:border-line-hover"
                  >
                    <span className="font-mono">@{team}</span>
                    <span className="text-fg-muted">{roleOf(team)}</span>
                    <ChevronDown aria-hidden="true" className="size-3.5 text-fg-faint" />
                    <span className="text-fg-muted">Change agent</span>
                  </button>
                )}
              />
            ) : (
              <span className="text-sm text-amber">No agent can work here yet. Add one in Agents.</span>
            )}
          </div>

          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="mb-2 p-0 text-sm text-fg-faint">Kind</legend>
            <div className="flex flex-wrap items-center gap-2">
              {KINDS.map((k) => (
                <ChoiceChip
                  key={k.id}
                  pressed={kindShown && kind === k.id}
                  disabled={!kindFits(k.id, chosen.length)}
                  className="h-[34px] text-sm"
                  title={k.hint}
                  onClick={() => setKindPick(k.id)}
                >
                  {k.id}
                </ChoiceChip>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="nt-type" className="text-sm text-fg-faint">
              Type
            </label>
            <Select
              id="nt-type"
              value={typePick ?? AUTO_TYPE}
              onChange={(event) =>
                setTypePick(event.target.value === AUTO_TYPE ? undefined : (event.target.value as TaskType))
              }
              className="w-44"
            >
              <option value={AUTO_TYPE}>Auto</option>
              {TASK_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TASK_TYPE_LABEL[type]}
                </option>
              ))}
            </Select>
          </div>

          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="mb-2 p-0 text-sm text-fg-faint">Project</legend>
            {projects.isPending && (
              <span className="h-8 animate-shimmer rounded-md bg-raised" aria-hidden="true" />
            )}
            {projects.data?.length === 0 && (
              <p className="text-sm text-fg-muted">
                No projects yet.{" "}
                <Link to="/projects" onClick={onClose} className="text-blue hover:underline">
                  Add one in Projects and links
                </Link>
                . A task without one is a chat task.
              </p>
            )}
            {groups.map((group) => (
              <div key={group.org} className="flex flex-wrap items-center gap-2">
                <OrgBadge label={group.badge} color={group.color} />
                <span className="sr-only">{group.name}</span>
                {group.projects.map((project) => {
                  const on = chosen.includes(project.id);
                  return (
                    <ChoiceChip
                      key={project.id}
                      mono
                      pressed={on}
                      className="h-[34px] text-sm"
                      onClick={() => setPicked(togglePicked(picked, project.id))}
                      title={
                        project.protected
                          ? "Protected: agents get it read-only unless you allow writes"
                          : undefined
                      }
                    >
                      {project.protected && <Lock aria-hidden="true" className="size-3 text-amber" />}
                      {project.id}
                    </ChoiceChip>
                  );
                })}
              </div>
            ))}
            {mixed !== undefined && (
              <p role="alert" className="text-sm text-amber text-pretty">
                These repos are in different workspaces ({mixed.join(", ")}). A task belongs to one workspace.
                Remove the repos of all but one.
              </p>
            )}
            {chosen.map((id) => {
              const fallback = projects.data?.find((p) => p.id === id)?.base;
              return (
                <div key={`base-${id}`} className="flex items-center gap-2">
                  <label htmlFor={`nt-base-${id}`} className="flex min-w-0 items-center gap-1.5 text-sm">
                    <span className="truncate font-mono">{id}</span>
                    <span className="shrink-0 text-fg-faint">starts from</span>
                  </label>
                  <input
                    id={`nt-base-${id}`}
                    value={bases[id] ?? ""}
                    onChange={(event) => setBases({ ...bases, [id]: event.target.value })}
                    placeholder={fallback ?? "default branch"}
                    spellCheck={false}
                    autoComplete="off"
                    className={cn(FIELD, "h-8 w-44 px-2.5 font-mono text-sm placeholder:text-fg-faint")}
                  />
                </div>
              );
            })}
            {chosen
              .filter((id) => projects.data?.find((p) => p.id === id)?.protected === true)
              .map((id) => (
                <div key={id} className="flex flex-col">
                  <Switch
                    label={`Let agents write in ${id} for this task`}
                    checked={writes.includes(id)}
                    onChange={(on) => setWrites(on ? [...writes, id] : writes.filter((w) => w !== id))}
                  />
                  <span className="text-xs text-fg-faint text-pretty">
                    {id} is protected. Off: agents read it only. It ships only alone, after you type its name.
                  </span>
                </div>
              ))}
            {mentioned.length > 0 && (
              <p className="flex flex-wrap items-center gap-1.5 text-sm text-fg-muted">
                Mentioned:
                {mentioned.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setPicked([...picked, id])}
                    className="cursor-pointer font-mono text-blue underline-offset-2 hover:underline"
                  >
                    Add {id}
                  </button>
                ))}
              </p>
            )}
          </fieldset>

          {choices.length > 0 && (
            <>
              <div className="flex flex-col gap-2">
                <span className="text-sm text-fg-faint">Depends on (optional)</span>
                <TaskChips label="Depends on" tasks={choices} selected={dependsOn} onChange={setDependsOn} />
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-sm text-fg-faint">Part of (optional)</span>
                <TaskChips label="Part of" tasks={choices} selected={parent} onChange={setParent} single />
              </div>
            </>
          )}

          {warnings.length > 0 && (
            <ul aria-label="Warnings" className="m-0 flex list-none flex-col gap-1 p-0">
              {warnings.map((warning) => (
                <li key={warning} className="text-sm text-amber">
                  {warning}
                </li>
              ))}
            </ul>
          )}

          {failure && (
            <p
              role="alert"
              className="rounded-md border border-red-line bg-red-wash px-3 py-2 text-sm text-red text-pretty"
            >
              {failure}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2.5 border-t border-line px-6 py-3.5">
          <Button
            variant="ghost"
            size="lg"
            aria-label="Attach a file or image"
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip aria-hidden="true" />
            Attach
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
          <Button variant="ghost" size="xl" className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            size="xl"
            className="bg-field"
            disabled={!ready}
            aria-busy={create.isPending && sendingStart === false}
            onClick={() => submit(false)}
          >
            {create.isPending && sendingStart === false ? "Adding..." : "Add to inbox"}
          </Button>
          <Button
            variant="primary"
            size="xl"
            disabled={!ready}
            aria-busy={create.isPending && sendingStart === true}
            title={`Add and start (${MOD_KEY} Enter)`}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            onClick={() => submit(true)}
          >
            {create.isPending && sendingStart === true ? "Adding..." : "Add and start"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
