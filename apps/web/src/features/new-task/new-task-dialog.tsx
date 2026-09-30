import { type ParsedTask, parseTaskText } from "@majhi/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronDown, Paperclip, X } from "lucide-react";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AttachmentChips } from "@/components/ui/attachment-chips";
import { Button } from "@/components/ui/button";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { Menu } from "@/components/ui/menu";
import { Modal } from "@/components/ui/modal";
import { OrgBadge } from "@/components/ui/org-badge";
import { useToast } from "@/components/ui/toast";
import { useAgentIndex } from "@/lib/agent-index";
import { cn } from "@/lib/cn";
import { MOD_KEY } from "@/lib/format";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { useAgents, useOrgs } from "@/lib/studio-queries";
import { useCreateTask, useProjects, useTasks } from "@/lib/task-queries";
import { attachmentIds, filesFromClipboard, useAttachments } from "@/lib/use-attachments";
import { defaultAgentId, eligibleAgents } from "../tasks/model";
import {
  canAdd,
  chosenProjects,
  composeTaskText,
  groupProjects,
  initialProjects,
  linkChoices,
  linkFields,
  namedProjects,
  togglePicked,
  typedText,
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

const FIELD =
  "w-full rounded-[10px] border border-line-control bg-field text-fg transition-[border-color] duration-150 hover:border-line-hover focus-visible:border-accent focus-visible:outline-none";

export function NewTaskDialog({ onClose }: { onClose: () => void }) {
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
  const titleField = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [agentOverride, setAgentOverride] = useState<string | undefined>();
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [parent, setParent] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | undefined>();
  const seeded = useRef(false);

  // The org filter preselects its only project, once the projects have loaded.
  useEffect(() => {
    if (seeded.current || !projects.data) return;
    seeded.current = true;
    setPicked(initialProjects(projects.data, filterOrg));
  }, [projects.data, filterOrg]);

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
  const chosen = chosenProjects(named, picked);
  const chosenOrg = projects.data?.find((p) => chosen.includes(p.id))?.org ?? filterOrg;
  const kind = chosen.length > 0 ? "code" : "chat";
  // What the server will read: the words plus the chips. Its warnings (an unknown @agent, repos from two orgs) show as they are.
  const warnings = tryParse(composeTaskText(draft, chosen, named), parseCtx)?.warnings ?? [];
  const team = agentOverride ?? parsed?.mentions[0] ?? defaultAgentId(agents ?? [], chosenOrg, kind);
  const groups = groupProjects(projects.data ?? [], orgs, filterOrg);
  const orgName = orgs.find((o) => o.id === chosenOrg)?.name;
  const choices = linkChoices(openTasks ?? [], filterOrg);
  const ready = canAdd(draft, attachments.uploading, create.isPending);

  function submit(start: boolean) {
    if (!ready) return;
    setFailure(undefined);
    create.mutate(
      {
        text: composeTaskText(draft, chosen, named),
        attachments: attachmentIds(attachments.items),
        start,
        ...linkFields(parent[0], dependsOn),
        ...(agentOverride ? { agent: agentOverride } : {}),
      },
      {
        onSuccess: (task) => {
          toast(
            start
              ? dependsOn.length > 0
                ? "Added, starts when ready"
                : "Task started"
              : "Added to the inbox",
            { detail: task.id },
          );
          onClose();
          void navigate({ to: "/t/$taskId", params: { taskId: task.id }, search: orgSearch(filterOrg) });
        },
        onError: (error) => setFailure([error.message, ...error.details].join(". ")),
      },
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
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
      <div
        onKeyDown={onKeyDown}
        className="flex max-h-[calc(100dvh-32px)] flex-col gap-4 overflow-y-auto px-6 py-[22px]"
      >
        <div className="flex items-center gap-2.5">
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
          {parsed?.base && (
            <p className="font-mono text-xs text-fg-muted">
              Branches from <span className="text-fg">{parsed.base}</span>
            </p>
          )}
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
          <span className="text-sm text-fg-muted">
            {agentOverride ? "Your pick." : `${orgName ?? "Default"} agent, picked for you.`} This agent does
            the task.
          </span>
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
                    title={named.includes(project.id) ? "Named in the title or details" : undefined}
                    onClick={() => setPicked(togglePicked(picked, named, project.id))}
                  >
                    {project.id}
                  </ChoiceChip>
                );
              })}
            </div>
          ))}
          {projects.data && projects.data.length > 0 && chosen.length === 0 && (
            <p className="text-sm text-fg-muted">
              No project chosen: this becomes a chat task, with no worktree.
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

        <div className="flex items-center gap-2.5 border-t border-line pt-3.5">
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
            onClick={() => submit(false)}
          >
            Add to inbox
          </Button>
          <Button
            variant="primary"
            size="xl"
            disabled={!ready}
            title={`Add and start (${MOD_KEY} Enter)`}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            onClick={() => submit(true)}
          >
            Add and start
          </Button>
        </div>
      </div>
    </Modal>
  );
}
