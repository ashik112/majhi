import { collapseHome, type DirEntry } from "@majhi/shared";
import {
  Check,
  ChevronRight,
  CircleAlert,
  CornerLeftUp,
  Eye,
  EyeOff,
  Folder,
  FolderGit2,
  Search,
  X,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { MOD_KEY, plural } from "@/lib/format";
import { useListDirs } from "@/lib/queries";
import { breadcrumbs, parentPath } from "./model";

type Item = { kind: "up"; path: string } | { kind: "dir"; entry: DirEntry };

function itemKey(item: Item): string {
  return item.kind === "up" ? ".." : item.entry.path;
}

export interface FolderBrowserProps {
  /** The owner's home on the host, shown as `~`. */
  home: string;
  startPath: string;
  /** Absolute paths already picked, marked in the list. */
  chosen: ReadonlySet<string>;
  /** Repo counts for folders the helper suggested, shown next to them. */
  counts: ReadonlyMap<string, number>;
  onPick: (path: string) => void;
  onClose: () => void;
}

/**
 * Browses host folders through the helper. Focus stays in the filter field: arrows move, Enter
 * opens, Backspace goes up, Cmd/Ctrl+Enter uses the folder on screen, Esc clears then closes.
 */
export function FolderBrowser({ home, startPath, chosen, counts, onPick, onClose }: FolderBrowserProps) {
  const id = useId();
  const [path, setPath] = useState(startPath);
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const listing = useListDirs(path, showHidden);
  // The previous folder's listing stays on screen, dimmed, while this one loads. Its rows, label
  // and `..` all describe that folder, and do not react to keys until the new one is in.
  const stale = listing.isPlaceholderData;

  const homePath = home.replace(/\/+$/, "");
  const label = collapseHome(path, homePath);
  const parent = parentPath(path);
  const crumbs = breadcrumbs(path, homePath);
  const needle = filter.trim().toLowerCase();
  const shown = listing.data;

  const items = useMemo<Item[]>(() => {
    if (!shown) return [];
    const matches = shown.entries.filter((entry) => entry.name.toLowerCase().includes(needle));
    const dirs = matches.map((entry): Item => ({ kind: "dir", entry }));
    return shown.parent !== null && needle === "" ? [{ kind: "up", path: shown.parent }, ...dirs] : dirs;
  }, [shown, needle]);

  // Without a remembered row, the cursor starts on the first folder rather than on `..`.
  let activeIndex = items.findIndex((item) => itemKey(item) === activeKey);
  if (activeIndex < 0)
    activeIndex = Math.max(
      0,
      items.findIndex((item) => item.kind === "dir"),
    );
  const active = items[activeIndex];

  useEffect(() => {
    document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [id, activeIndex]);

  const tooWide = path === homePath || parent === null;
  const alreadyRoot = chosen.has(path);
  const reason = tooWide ? "Pick a folder inside this one" : alreadyRoot ? "Already added" : null;
  const canPick = reason === null && !listing.isError;

  /** Shows `to`, with the cursor on `highlight` when it is in the new listing. */
  function navigate(to: string, highlight: string | null = null) {
    setPath(to);
    setFilter("");
    setActiveKey(highlight);
  }

  function goUp() {
    if (parent !== null) navigate(parent, path);
  }

  function open(item: Item) {
    if (item.kind === "up") goUp();
    else navigate(item.entry.path);
  }

  function pickCurrent() {
    if (canPick) onPick(path);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.shiftKey && event.code === "Period") {
      event.preventDefault();
      setShowHidden((shown) => !shown);
      return;
    }
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = items[Math.min(items.length - 1, Math.max(0, activeIndex + step))];
        if (next) setActiveKey(itemKey(next));
        break;
      }
      case "Enter":
        // Also keeps Cmd+Enter from reaching the form, where it would save.
        event.preventDefault();
        if (mod) pickCurrent();
        else if (active && !stale) open(active);
        break;
      case "Backspace":
        if (filter !== "") return;
        event.preventDefault();
        goUp();
        break;
      case "Escape":
        event.preventDefault();
        if (filter !== "") setFilter("");
        else onClose();
        break;
    }
  }

  return (
    <section aria-label="Folder browser" className="flex flex-col">
      <div className="flex h-11 items-center gap-2 border-b border-line pr-2 pl-3">
        <nav aria-label="Folder path" className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center font-mono text-sm">
            {crumbs.map((crumb, index) => {
              const last = index === crumbs.length - 1;
              return (
                <li key={crumb.path} className={cn("flex items-center", last ? "min-w-0" : "shrink-0")}>
                  {index > 0 && <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-fg-faint" />}
                  {last ? (
                    <span aria-current="location" className="truncate px-1.5 text-fg">
                      {crumb.label}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => navigate(crumb.path, crumbs[index + 1]?.path ?? null)}
                      className="h-6 cursor-pointer rounded-xs px-1.5 text-fg-muted transition-colors hover:bg-raised hover:text-fg"
                    >
                      {crumb.label}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close folder browser"
          title="Close (Esc)"
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      <div className="relative px-3 pt-3 pb-1.5">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-[calc(50%+3px)] left-[1.375rem] size-3.5 -translate-y-1/2 text-fg-faint"
        />
        <Input
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={active && !listing.isError ? `${id}-option-${activeIndex}` : undefined}
          aria-autocomplete="list"
          aria-label="Filter folders"
          aria-keyshortcuts="Backspace Meta+Enter Control+Enter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
          placeholder={`Filter folders in ${label}`}
          className="peer pr-28 pl-8"
        />
        {filter === "" && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-[calc(50%+3px)] right-5 flex -translate-y-1/2 items-center gap-2.5 text-xs text-fg-faint"
          >
            <span className="flex items-center gap-1">
              <Kbd>Enter</Kbd> open
            </span>
            <span className="flex items-center gap-1">
              <Kbd>⌫</Kbd> up
            </span>
          </span>
        )}
      </div>

      <div className="relative h-72 overflow-y-auto px-1.5 pb-1.5">
        {listing.isFetching && (
          <div aria-hidden="true" className="sticky top-0 z-10 -mx-1.5 h-0.5 overflow-hidden">
            <div className="h-full w-2/5 animate-scan bg-accent" />
          </div>
        )}

        {listing.isError ? (
          <div role="alert" className="flex flex-col items-start gap-2.5 px-2.5 py-3">
            <p className="flex items-center gap-2 text-base text-fg">
              <CircleAlert aria-hidden="true" className="size-3.5 shrink-0 text-red" />
              Cannot open <span className="font-mono">{label}</span>
            </p>
            <p className="text-sm break-words text-fg-muted">{listing.error.message}</p>
            {parent !== null && (
              <Button variant="secondary" size="sm" onClick={goUp}>
                <CornerLeftUp aria-hidden="true" />
                Go up
                <Kbd className="ml-0.5">⌫</Kbd>
              </Button>
            )}
          </div>
        ) : shown === undefined ? (
          <div aria-busy="true" className="flex flex-col pt-1">
            <span className="sr-only">Loading folders</span>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex h-9 items-center gap-2.5 px-2.5">
                <Skeleton className="size-3.5 rounded-xs" />
                <Skeleton className="h-3" style={{ width: `${[38, 26, 44, 30, 22][i]}%` }} />
              </div>
            ))}
          </div>
        ) : (
          <>
            <div
              id={`${id}-list`}
              role="listbox"
              aria-label={`Folders in ${collapseHome(shown.path, homePath)}`}
              className={cn("flex flex-col transition-opacity duration-150", stale && "opacity-70")}
            >
              {items.map((item, index) => (
                <FolderOption
                  key={itemKey(item)}
                  id={`${id}-option-${index}`}
                  item={item}
                  home={homePath}
                  active={index === activeIndex}
                  chosen={item.kind === "dir" && chosen.has(item.entry.path)}
                  repoCount={item.kind === "dir" ? counts.get(item.entry.path) : undefined}
                  onOpen={() => {
                    if (!stale) open(item);
                  }}
                />
              ))}
            </div>
            {shown.entries.length === 0 && (
              <p className="px-2.5 py-2 text-sm text-fg-faint">
                No folders in {collapseHome(shown.path, homePath)}.
                {showHidden ? "" : " Hidden folders are not shown."}
              </p>
            )}
            {shown.entries.length > 0 && needle !== "" && items.length === 0 && (
              <p className="px-2.5 py-2 text-sm text-fg-faint">No folders here match “{filter.trim()}”.</p>
            )}
            {shown.truncated && (
              <p className="px-2.5 py-2 text-sm text-fg-faint">
                Showing the first {plural(shown.entries.length, "folder")}. Type a path to reach one that is
                not listed.
              </p>
            )}
          </>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-line py-2.5 pr-4 pl-2.5">
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={showHidden}
          aria-keyshortcuts="Meta+Shift+Period Control+Shift+Period"
          onClick={() => setShowHidden((shown) => !shown)}
          className="aria-pressed:bg-raised aria-pressed:text-fg"
        >
          {showHidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
          Hidden folders
        </Button>
        <div className="ml-auto flex min-w-0 items-center gap-3">
          {reason && <span className="truncate text-sm text-fg-faint">{reason}</span>}
          <Button variant="secondary" onClick={pickCurrent} disabled={!canPick}>
            Use this folder
            <Kbd className="ml-0.5">{MOD_KEY} Enter</Kbd>
          </Button>
        </div>
      </div>
    </section>
  );
}

function FolderOption({
  id,
  item,
  home,
  active,
  chosen,
  repoCount,
  onOpen,
}: {
  id: string;
  item: Item;
  home: string;
  active: boolean;
  chosen: boolean;
  repoCount: number | undefined;
  onOpen: () => void;
}) {
  const name =
    item.kind === "up"
      ? `Up to ${collapseHome(item.path, home)}`
      : [
          item.entry.name,
          item.entry.isRepo && "git repo",
          repoCount !== undefined && plural(repoCount, "repo"),
          chosen && "already added",
        ]
          .filter(Boolean)
          .join(", ");
  return (
    // Focus stays in the filter field (aria-activedescendant); rows take clicks without taking focus.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the filter field handles every key for these rows
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      aria-label={name}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onOpen}
      className={cn(
        "flex h-9 shrink-0 cursor-pointer items-center gap-2.5 rounded-md px-2.5 transition-colors duration-75",
        active ? "bg-selected" : "hover:bg-raised",
      )}
    >
      {item.kind === "up" ? (
        <>
          <CornerLeftUp aria-hidden="true" className="size-3.5 shrink-0 text-fg-faint" />
          <span className="font-mono text-base text-fg-soft">..</span>
          <span className="truncate text-sm text-fg-faint">Up to {collapseHome(item.path, home)}</span>
        </>
      ) : (
        <>
          {item.entry.isRepo ? (
            <FolderGit2 aria-hidden="true" className="size-3.5 shrink-0 text-fg-soft" />
          ) : (
            <Folder aria-hidden="true" className="size-3.5 shrink-0 text-fg-faint" />
          )}
          <span className={cn("min-w-0 truncate text-base", item.entry.hidden ? "text-fg-muted" : "text-fg")}>
            {item.entry.name}
          </span>
          {item.entry.isRepo && <Badge>repo</Badge>}
          {repoCount !== undefined && (
            <span className="shrink-0 font-mono text-sm text-fg-faint tabular-nums">
              {plural(repoCount, "repo")}
            </span>
          )}
          {chosen && (
            <Badge tone="amber">
              <Check aria-hidden="true" strokeWidth={2.5} />
              root
            </Badge>
          )}
        </>
      )}
      <ChevronRight
        aria-hidden="true"
        className={cn("ml-auto size-3.5 shrink-0", active ? "text-fg-muted" : "text-transparent")}
      />
    </div>
  );
}
