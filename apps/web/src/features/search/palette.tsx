import { canWorkIn, type TaskSummary } from "@majhi/shared";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ChevronLeft, Search } from "lucide-react";
import { type ReactNode, useState } from "react";
import { AgentEmoji } from "@/components/agent-avatar";
import { Kbd } from "@/components/ui/kbd";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { matchesQuery } from "@/features/board/model";
import { useBoss } from "@/features/boss/boss-context";
import { chatTitle } from "@/features/chats/model";
import { GLOBAL } from "@/features/memory/model";
import { useNewTask } from "@/features/new-task/new-task-context";
import { AskBox } from "@/features/setup/decisions-panel";
import { PAGE_KEYWORDS, PAGE_LABEL } from "@/features/shell/nav";
import { openTaskIds } from "@/features/shell/use-shortcuts";
import { useCandidates } from "@/features/task/team-controls";
import { useAgentIndex } from "@/lib/agent-index";
import { cn } from "@/lib/cn";
import { formatAgo, MOD_KEY } from "@/lib/format";
import { useMemorySearch } from "@/lib/memory-queries";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { PAGE_PATH, type PageName } from "@/lib/pages";
import { MIN_SEARCH_LENGTH, useDebounced, useRoomSearch } from "@/lib/search-queries";
import { useOrgs } from "@/lib/studio-queries";
import { useStartTask, useTask, useTasks, useTeamCommand, useUpdateTask } from "@/lib/task-queries";
import { reopenOnboarding } from "@/onboarding/reopen";
import { matchCommands, type PaletteCommand } from "./commands";
import { HitRow } from "./hit-row";

const MAX_TASKS = 6;
const MAX_LIST = 30;

/** Where the palette is: the root (commands and search), or a list that one command opened. */
type Page =
  | { kind: "root" }
  | { kind: "tasks" }
  | { kind: "memory" }
  | { kind: "swap" }
  | { kind: "swap-with"; member: string }
  | { kind: "ask" };

const PLACEHOLDER: Record<Page["kind"], string> = {
  root: "Search, or run a command",
  tasks: "Go to task: an id, a title or a project",
  memory: "Search memory",
  swap: "Swap which agent?",
  "swap-with": "Swap for which agent?",
  ask: "Ask the decision model",
};

interface Entry {
  key: string;
  section: string;
  node: ReactNode;
  /** Dimmed, with the reason, and Enter does nothing. */
  unavailable?: string | undefined;
  run: () => void;
}

/**
 * A task shows its id; a chat has none the owner uses, so it shows its title, the agent, the
 * workspace and when it was last active.
 */
function TaskNode({
  task: t,
}: {
  task: Pick<TaskSummary, "id" | "title" | "chat" | "team" | "org" | "updatedAt">;
}) {
  const orgs = useOrgs().data;
  if (t.chat !== true)
    return (
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-mono text-xs text-fg-muted">{t.id}</span>
        <span className="min-w-0 truncate text-base">{t.title}</span>
      </span>
    );
  const agent = t.team[0];
  const workspace = t.org === undefined ? "Private" : (orgs?.find((o) => o.id === t.org)?.name ?? t.org);
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="min-w-0 truncate text-base">{chatTitle(t)}</span>
      <span className="flex min-w-0 shrink-0 items-center gap-1.5 text-xs text-fg-muted">
        {agent && <AgentEmoji id={agent} />}
        {agent && <span className="font-mono">@{agent}</span>}
        <span className="truncate">{workspace}</span>
        <span className="shrink-0 text-fg-faint">{formatAgo(t.updatedAt, Date.now())}</span>
      </span>
    </span>
  );
}

/**
 * Cmd K (SPEC 3.2): commands and search in one list. Type to filter the commands by name and to
 * find tasks, memory and anything said or run in a room. Some commands open a list of their own.
 * Arrow keys move, Enter runs, Esc goes back, and closes from the root.
 */
export function Palette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { org } = useOrgFilter();
  const toast = useToast();
  const newTask = useNewTask();
  const boss = useBoss();
  const tasks = useTasks().data;
  const index = useAgentIndex();
  const { taskId } = useParams({ strict: false }) as { taskId?: string };
  const current = useTask(taskId).data;
  const start = useStartTask();
  const update = useUpdateTask();
  const swap = useTeamCommand("team.swap");
  const candidates = useCandidates(current);

  const [page, setPage] = useState<Page>({ kind: "root" });
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const typed = query.trim();
  const settled = useDebounced(typed);
  const roomSearch = useRoomSearch(page.kind === "root" ? query : "", org);
  const memorySearch = useMemorySearch(
    (page.kind === "root" || page.kind === "memory") && settled.length >= MIN_SEARCH_LENGTH ? settled : "",
  );

  const go = (to: string, search: Record<string, string> = {}) => {
    onClose();
    // The page paths are the router's own; the extra keys are search params every page may carry.
    void navigate({ to, search: { ...orgSearch(org), ...search } } as never);
  };
  const open = (id: string, item?: string) => {
    onClose();
    void navigate({
      to: "/t/$taskId",
      params: { taskId: id },
      search: { ...orgSearch(org), ...(item === undefined ? {} : { item }) },
    });
  };
  const into = (next: Page) => {
    setPage(next);
    setQuery("");
    setCursor(0);
  };
  const failed = (what: string) => (e: Error) => toast(what, { detail: e.message, tone: "error" });

  const paused = (tasks ?? []).filter((t) => t.status === "paused");
  const commands: PaletteCommand[] = [
    {
      id: "new-task",
      name: "New task",
      keywords: "create add start",
      run: () => (onClose(), newTask.open()),
    },
    {
      id: "add-account",
      name: "Add account",
      keywords: "sign in claude codex login",
      run: () => go(PAGE_PATH.accounts, { create: org ?? "1" }),
    },
    {
      id: "new-agent",
      name: "New agent",
      keywords: "create add",
      run: () => go(PAGE_PATH.agents, { create: org ?? "root" }),
    },
    {
      id: "install-skill",
      name: "Install skill from link",
      keywords: "skills github zip folder",
      hint: "Opens Skills",
      run: () => go(PAGE_PATH.skills),
    },
    {
      id: "search-memory",
      name: "Search memory",
      keywords: "lessons facts",
      run: () => into({ kind: "memory" }),
    },
    {
      id: "swap-agent",
      name: "Swap an agent in this task",
      keywords: "change replace",
      task: true,
      unavailable: current === undefined ? "Loading the task" : undefined,
      run: () => {
        if (current === undefined) return;
        // A chat has one agent to change; a team picks which member to swap first.
        if (current.kind === "chat" || current.team.length <= 1)
          return into({ kind: "swap-with", member: current.team[0] ?? "" });
        into({ kind: "swap" });
      },
    },
    {
      id: "resume-paused",
      name: "Resume paused runs",
      keywords: "continue paused limit",
      hint: paused.length === 0 ? undefined : String(paused.length),
      unavailable: paused.length === 0 ? "No paused runs" : undefined,
      run: () => {
        onClose();
        void Promise.allSettled(paused.map((t) => start.mutateAsync(t.id))).then((results) => {
          const bad = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
          toast(
            bad.length === 0
              ? `Resumed ${paused.length} paused ${paused.length === 1 ? "run" : "runs"}`
              : `Resumed ${paused.length - bad.length} of ${paused.length}`,
            bad.length === 0
              ? {}
              : { detail: String(bad[0]?.reason?.message ?? bad[0]?.reason), tone: "error" },
          );
        });
      },
    },
    { id: "go-to-task", name: "Go to task", keywords: "open jump", run: () => into({ kind: "tasks" }) },
    {
      id: "connections",
      name: "Open connections",
      keywords: "kubectl kubernetes cluster mcp new relic ssh server env variables keys mail browser",
      run: () => go(PAGE_PATH.connections),
    },
    {
      id: "audit",
      name: "Open the audit log",
      keywords: "history pushes merges approvals who did what",
      run: () => go(PAGE_PATH.audit),
    },
    {
      id: "budgets",
      name: "Edit budgets",
      keywords: "limits spend cost tokens daily weekly alerts floors",
      hint: "On Limits",
      run: () => go(PAGE_PATH.limits),
    },
    {
      id: "roots",
      name: "Manage project folders",
      keywords: "folders projects repos paths roots",
      run: () => go("/settings/roots"),
    },
    {
      id: "ask-decision",
      name: "Ask the decision model",
      keywords: "decide laya jev classify",
      run: () => into({ kind: "ask" }),
    },
    {
      id: "onboarding",
      name: "Reopen onboarding",
      keywords: "setup welcome first run",
      run: () => (onClose(), reopenOnboarding()),
    },
    {
      id: "boss",
      name: "Open the captain",
      keywords: "chat assistant",
      hint: `${MOD_KEY} J`,
      run: () => (onClose(), boss.show()),
    },
    {
      id: "captain-today",
      name: "Captain: what it is doing today",
      keywords: "autonomous autopilot away summary running next queue",
      run: () => go(PAGE_PATH.captain, { tab: "today" }),
    },
    {
      id: "captain-log",
      name: "Captain: log of what it did",
      keywords: "autonomous decisions undo feed history",
      run: () => go(PAGE_PATH.captain, { tab: "log" }),
    },
    {
      id: "captain-rules",
      name: "Captain: rules",
      keywords: "autonomous authority who decides what pick leave alone standing instructions",
      run: () => go(PAGE_PATH.captain, { tab: "rules" }),
    },
  ];

  // Every page, found by its name once something is typed.
  const pages: PaletteCommand[] = (Object.keys(PAGE_LABEL) as PageName[]).map((name) => ({
    id: `page:${name}`,
    name: PAGE_LABEL[name],
    keywords: `page go open ${PAGE_KEYWORDS[name]}`,
    hint: "Page",
    run: () => go(PAGE_PATH[name]),
  }));

  const entries = ((): Entry[] => {
    const out: Entry[] = [];
    const taskList = tasks ?? [];
    const fromTasks = (list: readonly TaskSummary[], section: string) =>
      list.map<Entry>((t) => ({
        key: `task:${t.id}`,
        section,
        node: <TaskNode task={t} />,
        run: () => open(t.id),
      }));

    if (page.kind === "root") {
      for (const c of matchCommands(commands, typed, taskId !== undefined)) {
        out.push({
          key: `cmd:${c.id}`,
          section: "Commands",
          unavailable: c.unavailable,
          run: c.run,
          node: (
            <span className="flex w-full min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate text-base">{c.name}</span>
              {(c.unavailable ?? c.hint) && (
                <span className="ml-auto shrink-0 text-xs text-fg-faint">{c.unavailable ?? c.hint}</span>
              )}
            </span>
          ),
        });
      }
      if (typed !== "") {
        for (const p of matchCommands(pages, typed, false)) {
          out.push({
            key: `cmd:${p.id}`,
            section: "Pages",
            run: p.run,
            node: (
              <span className="flex w-full min-w-0 items-baseline gap-2">
                <span className="min-w-0 truncate text-base">{p.name}</span>
                <span className="ml-auto shrink-0 text-xs text-fg-faint">{p.hint}</span>
              </span>
            ),
          });
        }
        out.push(...fromTasks(taskList.filter((t) => matchesQuery(t, typed)).slice(0, MAX_TASKS), "Tasks"));
      }
    }
    if (page.kind === "tasks") {
      const open = openTaskIds(taskList, org);
      const byId = new Map(taskList.map((t) => [t.id, t]));
      const ordered = [
        ...open.flatMap((id) => byId.get(id) ?? []),
        ...taskList.filter((t) => !open.includes(t.id)),
      ];
      out.push(...fromTasks(ordered.filter((t) => matchesQuery(t, typed)).slice(0, MAX_LIST), "Tasks"));
    }
    if (page.kind === "root" || page.kind === "memory") {
      const hits = settled.length >= MIN_SEARCH_LENGTH ? (memorySearch.data ?? []) : [];
      for (const { fact } of hits.slice(0, page.kind === "memory" ? MAX_LIST : MAX_TASKS)) {
        out.push({
          key: `fact:${fact.id}`,
          section: "Memory",
          run: () =>
            go(PAGE_PATH.memory, {
              project: fact.scope.startsWith("project:") ? fact.scope.slice("project:".length) : GLOBAL,
              tab: "lessons",
            }),
          node: (
            <span className="flex w-full min-w-0 flex-col gap-0.5">
              <span className="line-clamp-2 text-base break-words">{fact.text}</span>
              <span className="text-xs text-fg-faint">{fact.scope}</span>
            </span>
          ),
        });
      }
    }
    if (page.kind === "swap" && current) {
      for (const id of current.team) {
        if (!matchesWords(`@${id} ${index.get(id)?.role ?? ""}`, typed)) continue;
        out.push({
          key: `member:${id}`,
          section: "Swap which agent",
          run: () => into({ kind: "swap-with", member: id }),
          node: <span className="text-base">{`@${id} · ${index.get(id)?.role ?? ""}`}</span>,
        });
      }
    }
    if (page.kind === "swap-with" && current) {
      const chat = current.kind === "chat" || current.team.length <= 1;
      const choices = chat
        ? [...index.values()]
            .filter((a) => canWorkIn(a, current.org) && a.id !== page.member)
            .toSorted(
              (a, b) =>
                Number(b.scope === current.org) - Number(a.scope === current.org) || a.id.localeCompare(b.id),
            )
        : candidates;
      for (const a of choices) {
        if (!matchesWords(`@${a.id} ${a.role} ${a.account}`, typed)) continue;
        out.push({
          key: `with:${a.id}`,
          section: page.member ? `Swap @${page.member} for` : "Give the task to",
          run: () => {
            onClose();
            const done = failed("Could not swap the agent");
            if (chat) update.mutate({ id: current.id, agent: a.id }, { onError: done });
            else swap.mutate({ task: current.id, agent: page.member, with: a.id }, { onError: done });
          },
          node: <span className="text-base">{`@${a.id} · ${a.role} · ${a.account}`}</span>,
        });
      }
    }
    if (page.kind === "root" && typed.length >= MIN_SEARCH_LENGTH) {
      for (const hit of roomSearch.data ?? []) {
        out.push({
          key: `hit:${hit.task}:${hit.item}`,
          section: "Messages and tool output",
          run: () => open(hit.task, hit.item),
          node: <HitRow hit={hit} />,
        });
      }
    }
    return out;
  })();

  const active = Math.min(cursor, Math.max(entries.length - 1, 0));

  function back() {
    into({ kind: "root" });
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setCursor(entries.length === 0 ? 0 : (active + step + entries.length) % entries.length);
    } else if (event.key === "Enter") {
      const entry = entries[active];
      if (entry && entry.unavailable === undefined) {
        event.preventDefault();
        entry.run();
      }
    } else if (page.kind !== "root" && event.key === "Escape") {
      // Esc steps back out of a list; from the root it closes the palette as before.
      event.preventDefault();
      event.stopPropagation();
      back();
    } else if (page.kind !== "root" && event.key === "Backspace" && query === "") {
      event.preventDefault();
      back();
    }
  }

  // Group the rows under their section headings, keeping one running index for the cursor.
  const sections: { name: string; rows: { entry: Entry; index: number }[] }[] = [];
  entries.forEach((entry, index) => {
    const last = sections.at(-1);
    if (last && last.name === entry.section) last.rows.push({ entry, index });
    else sections.push({ name: entry.section, rows: [{ entry, index }] });
  });

  const searching =
    (page.kind === "root" && typed.length >= MIN_SEARCH_LENGTH && roomSearch.isFetching) ||
    memorySearch.isFetching;

  return (
    <Modal label="Command palette" onClose={onClose} className="mt-[12vh] w-[640px]">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys and Enter are caught from the search field inside */}
      <div className="flex flex-col" onKeyDown={onKeyDown}>
        <label className="relative flex items-center border-b border-line">
          <span className="sr-only">{PLACEHOLDER[page.kind]}</span>
          {page.kind === "root" ? (
            <Search aria-hidden="true" className="pointer-events-none absolute left-4 size-4 text-fg-faint" />
          ) : (
            <ChevronLeft
              aria-hidden="true"
              className="pointer-events-none absolute left-4 size-4 text-fg-faint"
            />
          )}
          <input
            // biome-ignore lint/a11y/noAutofocus: the palette opens to be typed into
            autoFocus
            key={page.kind}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            placeholder={PLACEHOLDER[page.kind]}
            autoComplete="off"
            spellCheck={false}
            className="h-12 w-full bg-transparent pr-4 pl-11 text-body text-fg outline-none placeholder:text-fg-faint"
          />
        </label>
        <div className="max-h-[56vh] overflow-y-auto p-2">
          {page.kind === "ask" ? (
            <div className="p-2">
              <AskBox />
            </div>
          ) : (
            <div role="listbox" aria-label="Results" className="flex flex-col gap-2">
              {sections.map((section) => (
                <section key={section.name}>
                  <h2 className="px-3 py-1 text-xs font-semibold tracking-wide text-fg-faint uppercase">
                    {section.name}
                  </h2>
                  <ul>
                    {section.rows.map(({ entry, index: i }) => (
                      <li key={entry.key}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={i === active}
                          aria-disabled={entry.unavailable !== undefined}
                          tabIndex={-1}
                          onClick={() => entry.unavailable === undefined && entry.run()}
                          onMouseMove={() => setCursor(i)}
                          className={cn(
                            "flex w-full rounded-md px-3 py-2 text-left",
                            entry.unavailable === undefined ? "cursor-pointer" : "cursor-default opacity-55",
                            i === active ? "bg-selected" : "hover:bg-selected/60",
                          )}
                        >
                          {entry.node}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {entries.length === 0 && (
                <p className="px-3 py-6 text-center text-base text-fg-muted">
                  {searching
                    ? "Searching…"
                    : page.kind === "root" && typed.length < MIN_SEARCH_LENGTH
                      ? "Keep typing."
                      : roomSearch.isError
                        ? `Search failed. ${roomSearch.error.message}`
                        : "Nothing found."}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-xs text-fg-faint">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <span>move</span>
          <Kbd>Enter</Kbd>
          <span>run</span>
          <Kbd>Esc</Kbd>
          <span>{page.kind === "root" ? "close" : "back"}</span>
        </div>
      </div>
    </Modal>
  );
}

/** Every typed word starts a word of the text. Nothing typed matches all. */
function matchesWords(text: string, typed: string): boolean {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  const have = text
    .toLowerCase()
    .split(/[^a-z0-9@-]+/)
    .filter(Boolean);
  return words.every((w) => have.some((h) => h.startsWith(w) || h.startsWith(`@${w}`)));
}
