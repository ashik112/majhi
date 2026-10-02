import { collapseHome, expandHome } from "@majhi/shared";
import { CircleAlert, Folder, FolderCheck, FolderOpen, TextCursorInput, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { plural } from "@/lib/format";
import { useSuggestRoots } from "@/lib/queries";
import { FolderBrowser } from "./folder-browser";
import { checkNewRoot, chosenPaths, parentPath, type RootRow } from "./model";
import { SuggestionList } from "./suggestion-list";

export interface RootPickerProps {
  formId: string;
  home: string;
  rows: readonly RootRow[];
  rowErrors: ReadonlyMap<number, string>;
  /** Shown under the chosen roots once the owner tried to save. */
  formError: string | undefined;
  onAdd: (value: string) => void;
  onRemove: (id: number) => void;
  /** Saves with `value` added; used when Cmd+Enter lands in the path field before Enter did. */
  onSubmitWith: (value: string) => void;
}

/**
 * Picks roots without typing (SPEC 3.5): suggestions first, then a folder browser, then a typed
 * path for keyboard users. Picked roots collect in the list below.
 */
export function RootPicker({
  formId,
  home,
  rows,
  rowErrors,
  formError,
  onAdd,
  onRemove,
  onSubmitWith,
}: RootPickerProps) {
  const suggestions = useSuggestRoots();
  const homePath = home.replace(/\/+$/, "");
  const [browsing, setBrowsing] = useState(false);
  const [browseFrom, setBrowseFrom] = useState(homePath);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);
  // The top suggestion takes focus once, on arrival; not again after the browser closes.
  const [firstVisit, setFirstVisit] = useState(true);

  const browseId = `${formId}-browse`;
  const typeId = `${formId}-type`;
  /** Id of the element to focus once the next render is on screen. */
  const focusAfterRender = useRef<string | null>(null);

  const chosen = useMemo(() => chosenPaths(rows, home), [rows, home]);
  const counts = useMemo(
    () => new Map((suggestions.data ?? []).map((s) => [s.path, s.repoCount])),
    [suggestions.data],
  );
  const listed = rows.filter((row) => row.value.trim() !== "");

  useEffect(() => {
    if (focusAfterRender.current === null) return;
    document.getElementById(focusAfterRender.current)?.focus();
    focusAfterRender.current = null;
  });

  function removeByPath(path: string) {
    const row = rows.find((r) => r.value.trim() !== "" && expandHome(r.value, home) === path);
    if (row) onRemove(row.id);
  }

  function openBrowser() {
    setFirstVisit(false);
    setBrowsing(true);
  }

  function closeBrowser() {
    setBrowsing(false);
    focusAfterRender.current = browseId;
  }

  function pickFolder(path: string) {
    onAdd(collapseHome(path, homePath));
    setBrowseFrom(parentPath(path) ?? homePath);
    closeBrowser();
  }

  function toggleTyping() {
    setFirstVisit(false);
    setTyping(!typing);
    setTypedError(null);
    if (typing) focusAfterRender.current = typeId;
  }

  function addTyped(): string | null {
    const result = checkNewRoot(typed, rows, home);
    if ("error" in result) {
      setTypedError(result.error);
      return null;
    }
    onAdd(result.value);
    setTyped("");
    return result.value;
  }

  function onTypedKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === "Enter" && !mod) {
      event.preventDefault();
      addTyped();
    } else if (event.key === "Enter" && typed.trim() !== "") {
      // Cmd+Enter with a path still in the field: add it, then save with it.
      event.preventDefault();
      const value = addTyped();
      if (value !== null) onSubmitWith(value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      toggleTyping();
    }
  }

  function removeChosen(index: number) {
    const row = listed[index];
    if (!row) return;
    const neighbour = listed[index + 1] ?? listed[index - 1];
    focusAfterRender.current = neighbour ? `${formId}-remove-${neighbour.id}` : browseId;
    onRemove(row.id);
  }

  const typedErrorId = `${formId}-typed-error`;

  return (
    <>
      {browsing ? (
        <FolderBrowser
          home={homePath}
          startPath={browseFrom}
          chosen={chosen}
          counts={counts}
          onPick={pickFolder}
          onClose={closeBrowser}
        />
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <SuggestionList
            home={homePath}
            suggestions={suggestions.data}
            error={suggestions.isError && !suggestions.error.hostOffline ? suggestions.error : null}
            chosen={chosen}
            autoFocus={firstVisit}
            onToggle={(path) => (chosen.has(path) ? removeByPath(path) : onAdd(collapseHome(path, homePath)))}
          />
          <div className="flex items-center gap-1">
            <Button id={browseId} variant="secondary" size="sm" onClick={openBrowser}>
              <FolderOpen aria-hidden="true" />
              Browse folders
            </Button>
            <Button
              id={typeId}
              variant="ghost"
              size="sm"
              aria-expanded={typing}
              aria-controls={`${formId}-typed`}
              onClick={toggleTyping}
            >
              <TextCursorInput aria-hidden="true" />
              Type a path
            </Button>
          </div>
          {typing && (
            <div id={`${formId}-typed`} className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <div className="relative min-w-0 flex-1">
                  <Folder
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-fg-faint"
                  />
                  <Input
                    value={typed}
                    onChange={(event) => {
                      setTyped(event.target.value);
                      setTypedError(null);
                    }}
                    onKeyDown={onTypedKeyDown}
                    autoFocus
                    placeholder="~/code or /absolute/path"
                    aria-label="Folder path"
                    aria-invalid={typedError ? true : undefined}
                    aria-describedby={typedError ? typedErrorId : undefined}
                    className="h-9 pl-9 font-mono"
                  />
                </div>
                <Button variant="secondary" onClick={() => addTyped()}>
                  Add
                </Button>
              </div>
              {typedError && (
                <p id={typedErrorId} className="flex items-center gap-1.5 pl-1 text-sm text-red">
                  <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
                  {typedError}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <section
        aria-labelledby={`${formId}-chosen`}
        className="flex flex-col border-t border-line px-4 pt-3 pb-3.5"
      >
        <div className="flex h-6 items-center justify-between">
          <h2 id={`${formId}-chosen`} className="text-sm text-fg-muted">
            Folders
          </h2>
          <span className="font-mono text-xs text-fg-faint tabular-nums">{listed.length}</span>
        </div>
        {listed.length === 0 ? (
          <p className="pt-1 text-sm text-fg-faint">None yet. Add a suggestion or browse to a folder.</p>
        ) : (
          <ul aria-labelledby={`${formId}-chosen`} className="flex flex-col pt-1">
            {listed.map((row, index) => {
              const count = counts.get(expandHome(row.value, home));
              const error = rowErrors.get(row.id);
              return (
                <li key={row.id} className="flex flex-col">
                  <div className="flex h-9 items-center gap-2.5">
                    <FolderCheck aria-hidden="true" className="size-3.5 shrink-0 text-accent-text" />
                    <span
                      className="min-w-0 truncate font-mono text-base text-fg"
                      title={expandHome(row.value, home)}
                    >
                      {row.value}
                    </span>
                    {count !== undefined && (
                      <span className="shrink-0 font-mono text-sm text-fg-faint tabular-nums">
                        {plural(count, "repo")}
                      </span>
                    )}
                    <Button
                      id={`${formId}-remove-${row.id}`}
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => removeChosen(index)}
                      aria-label={`Remove ${row.value}`}
                      title="Remove"
                      className="-mr-1.5 ml-auto"
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </div>
                  {error && (
                    <p className="flex items-center gap-1.5 pb-1.5 pl-6 text-sm text-red">
                      <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
                      {error}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {formError && (
          <p role="alert" className="flex items-center gap-1.5 pt-1.5 text-sm text-red">
            <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            {formError}
          </p>
        )}
      </section>
    </>
  );
}
