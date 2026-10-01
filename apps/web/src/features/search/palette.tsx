import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Kbd } from "@/components/ui/kbd";
import { Modal } from "@/components/ui/modal";
import { matchesQuery } from "@/features/board/model";
import { cn } from "@/lib/cn";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { MIN_SEARCH_LENGTH, useRoomSearch } from "@/lib/search-queries";
import { useTasks } from "@/lib/task-queries";
import { HitRow } from "./hit-row";

const MAX_TASKS = 6;

interface Entry {
  key: string;
  task: string;
  node: React.ReactNode;
}

/**
 * Cmd K: find a task by id, title or project, or a message or tool output in any task's room.
 * Arrow keys move, Enter opens the task, Esc closes.
 */
export function Palette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { org } = useOrgFilter();
  const tasks = useTasks().data;
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const search = useRoomSearch(query, org);
  const typed = query.trim();

  const { taskEntries, messageEntries } = useMemo(() => {
    const byTask = (tasks ?? [])
      .filter((t) => typed !== "" && matchesQuery(t, typed))
      .slice(0, MAX_TASKS)
      .map<Entry>((t) => ({
        key: `task:${t.id}`,
        task: t.id,
        node: (
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-xs text-fg-muted">{t.id}</span>
            <span className="min-w-0 truncate text-base">{t.title}</span>
          </span>
        ),
      }));
    const byMessage = (typed.length >= MIN_SEARCH_LENGTH ? (search.data ?? []) : []).map<Entry>((hit) => ({
      key: `hit:${hit.task}:${hit.item}`,
      task: hit.task,
      node: <HitRow hit={hit} />,
    }));
    return { taskEntries: byTask, messageEntries: byMessage };
  }, [tasks, typed, search.data]);

  const entries = [...taskEntries, ...messageEntries];
  const active = Math.min(cursor, Math.max(entries.length - 1, 0));

  function open(task: string) {
    onClose();
    void navigate({ to: "/t/$taskId", params: { taskId: task }, search: orgSearch(org) });
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setCursor(entries.length === 0 ? 0 : (active + step + entries.length) % entries.length);
    } else if (event.key === "Enter") {
      const entry = entries[active];
      if (entry) {
        event.preventDefault();
        open(entry.task);
      }
    }
  }

  const row = (entry: Entry, index: number) => (
    <li key={entry.key}>
      <button
        type="button"
        role="option"
        aria-selected={index === active}
        tabIndex={-1}
        onClick={() => open(entry.task)}
        onMouseMove={() => setCursor(index)}
        className={cn(
          "flex w-full cursor-pointer rounded-md px-3 py-2 text-left",
          index === active ? "bg-selected" : "hover:bg-selected/60",
        )}
      >
        {entry.node}
      </button>
    </li>
  );

  return (
    <Modal label="Search" onClose={onClose} className="mt-[12vh] w-[640px]">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys and Enter are caught from the search field inside */}
      <div className="flex flex-col" onKeyDown={onKeyDown}>
        <label className="relative flex items-center border-b border-line">
          <span className="sr-only">Search tasks, messages and tool output</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-4 size-4 text-fg-faint" />
          <input
            // biome-ignore lint/a11y/noAutofocus: the palette opens to be typed into
            autoFocus
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            placeholder="Search tasks, messages and tool output"
            autoComplete="off"
            spellCheck={false}
            className="h-12 w-full bg-transparent pr-4 pl-11 text-body text-fg outline-none placeholder:text-fg-faint"
          />
        </label>
        <div className="max-h-[56vh] overflow-y-auto p-2">
          {typed === "" ? (
            <p className="px-3 py-6 text-center text-base text-fg-muted">
              Type to search task titles and everything said or run in any room.
            </p>
          ) : (
            <div role="listbox" aria-label="Results" className="flex flex-col gap-2">
              {taskEntries.length > 0 && (
                <section>
                  <h2 className="px-3 py-1 text-xs font-semibold tracking-wide text-fg-faint uppercase">
                    Tasks
                  </h2>
                  <ul>{taskEntries.map((entry, i) => row(entry, i))}</ul>
                </section>
              )}
              {messageEntries.length > 0 && (
                <section>
                  <h2 className="px-3 py-1 text-xs font-semibold tracking-wide text-fg-faint uppercase">
                    Messages and tool output
                  </h2>
                  <ul>{messageEntries.map((entry, i) => row(entry, taskEntries.length + i))}</ul>
                </section>
              )}
              {entries.length === 0 && (
                <p className="px-3 py-6 text-center text-base text-fg-muted">
                  {search.isFetching
                    ? "Searching…"
                    : typed.length < MIN_SEARCH_LENGTH
                      ? "Keep typing."
                      : search.isError
                        ? `Search failed. ${search.error.message}`
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
          <span>open</span>
          <Kbd>Esc</Kbd>
          <span>close</span>
        </div>
      </div>
    </Modal>
  );
}
