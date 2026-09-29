import { collapseHome, type RootSuggestion } from "@majhi/shared";
import { Check, CircleAlert, Folder, Plus } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { ApiRequestError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { plural } from "@/lib/format";

/**
 * Likely roots from the host helper: folders under home that hold git repos. One click or Enter
 * adds a folder, a second removes it. Arrow keys move between rows.
 */
export function SuggestionList({
  home,
  suggestions,
  error,
  chosen,
  autoFocus,
  onToggle,
}: {
  home: string;
  /** Undefined while loading. */
  suggestions: readonly RootSuggestion[] | undefined;
  error: ApiRequestError | null;
  /** Absolute paths already picked. */
  chosen: ReadonlySet<string>;
  /** Focus the top suggestion once it shows, unless the owner is already somewhere else. */
  autoFocus: boolean;
  onToggle: (path: string) => void;
}) {
  const first = useRef<HTMLButtonElement>(null);
  const hasRows = suggestions !== undefined && suggestions.length > 0;

  useEffect(() => {
    if (!autoFocus || !hasRows) return;
    const active = document.activeElement;
    if (active === null || active === document.body) first.current?.focus();
  }, [autoFocus, hasRows]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const item = event.currentTarget.closest("li");
    const next = event.key === "ArrowDown" ? item?.nextElementSibling : item?.previousElementSibling;
    next?.querySelector("button")?.focus();
  }

  return (
    <section aria-labelledby="suggested-title" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="suggested-title" className="text-sm text-fg-muted">
          Suggested
        </h2>
        <p className="truncate text-xs text-fg-faint">Folders in your home that hold git repos</p>
      </div>

      {error ? (
        <p className="flex items-start gap-2 rounded-md border border-line-strong px-3 py-2.5 text-sm text-fg-muted">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-red" />
          <span>
            Could not look for suggestions: <span className="font-mono text-fg-soft">{error.message}</span>.
            Browse instead.
          </span>
        </p>
      ) : suggestions === undefined ? (
        <div aria-busy="true" className="flex flex-col rounded-md border border-line-strong">
          <span className="sr-only">Looking for folders with git repos</span>
          {[0, 1].map((i) => (
            <div key={i} className="flex h-10 items-center gap-2.5 border-line-strong px-3 not-last:border-b">
              <Skeleton className="size-3.5 rounded-xs" />
              <Skeleton className="h-3 w-28" />
              <Skeleton className="ml-auto h-3 w-12" />
            </div>
          ))}
        </div>
      ) : suggestions.length === 0 ? (
        <p className="rounded-md border border-dashed border-line-strong px-3 py-2.5 text-sm text-fg-muted">
          No folder in your home holds a git repo that majhi can find. Browse to pick one.
        </p>
      ) : (
        <ul
          aria-labelledby="suggested-title"
          className="flex max-h-60 flex-col overflow-y-auto rounded-md border border-line-strong"
        >
          {suggestions.map((suggestion, index) => {
            const added = chosen.has(suggestion.path);
            const label = collapseHome(suggestion.path, home);
            return (
              <li key={suggestion.path} className="border-line-strong not-last:border-b">
                <button
                  ref={index === 0 ? first : undefined}
                  type="button"
                  aria-pressed={added}
                  aria-label={`${label}, ${plural(suggestion.repoCount, "repo")}`}
                  onClick={() => onToggle(suggestion.path)}
                  onKeyDown={onKeyDown}
                  title={suggestion.path}
                  className={cn(
                    "group flex h-10 w-full cursor-pointer items-center gap-2.5 px-3 text-left transition-colors duration-100",
                    "focus-visible:-outline-offset-2",
                    added ? "bg-amber-wash hover:bg-amber-wash/70" : "hover:bg-raised",
                  )}
                >
                  <Folder
                    aria-hidden="true"
                    className={cn("size-3.5 shrink-0", added ? "text-amber" : "text-fg-faint")}
                  />
                  <span className="min-w-0 truncate font-mono text-base text-fg">{label}</span>
                  <span className="shrink-0 font-mono text-sm text-fg-faint tabular-nums">
                    {plural(suggestion.repoCount, "repo")}
                  </span>
                  <span
                    className={cn(
                      "ml-auto flex shrink-0 items-center gap-1 text-sm",
                      added ? "text-amber" : "text-fg-muted group-hover:text-fg group-focus-visible:text-fg",
                    )}
                  >
                    {added ? (
                      <>
                        <Check aria-hidden="true" className="size-3.5" strokeWidth={2.5} />
                        Added
                      </>
                    ) : (
                      <>
                        <Plus aria-hidden="true" className="size-3.5" />
                        Add
                      </>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
