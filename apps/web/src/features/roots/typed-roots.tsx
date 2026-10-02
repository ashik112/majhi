import { RESTART_COMMAND } from "@majhi/shared";
import { CircleAlert, Folder, Info, Plus, X } from "lucide-react";
import {
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import { InlineCommand } from "@/components/command-line";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import type { RootRow, RootsCheck } from "./model";

/**
 * The roots editor when no host helper is connected: one text field per root. Enter on a filled
 * row adds the next one, Backspace on an empty row removes it.
 */
export function TypedRoots({
  formId,
  rows,
  setRows,
  newId,
  check,
  submitted,
  inputs,
}: {
  formId: string;
  rows: readonly RootRow[];
  setRows: Dispatch<SetStateAction<RootRow[]>>;
  newId: () => number;
  check: RootsCheck;
  submitted: boolean;
  /** Filled with each row's input, so the form can focus the first bad one on save. */
  inputs: RefObject<Map<number, HTMLInputElement>>;
}) {
  const [touched, setTouched] = useState<ReadonlySet<number>>(() => new Set());
  const focusAfterRender = useRef<number | null>(null);

  useEffect(() => {
    if (focusAfterRender.current === null) return;
    inputs.current.get(focusAfterRender.current)?.focus();
    focusAfterRender.current = null;
  });

  function updateRow(id: number, value: string) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, value } : r)));
  }

  function addRowAfter(index: number) {
    const next = rows[index + 1];
    if (next && next.value.trim() === "") {
      inputs.current.get(next.id)?.focus();
      return;
    }
    const id = newId();
    focusAfterRender.current = id;
    setRows((prev) => [...prev.slice(0, index + 1), { id, value: "" }, ...prev.slice(index + 1)]);
  }

  function removeRow(index: number) {
    const row = rows[index];
    if (!row) return;
    if (rows.length === 1) {
      updateRow(row.id, "");
      focusAfterRender.current = row.id;
      return;
    }
    const neighbour = rows[index - 1] ?? rows[index + 1];
    if (neighbour) focusAfterRender.current = neighbour.id;
    setRows((prev) => prev.filter((r) => r.id !== row.id));
  }

  function onRowKeyDown(event: KeyboardEvent<HTMLInputElement>, index: number, row: RootRow) {
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      if (row.value.trim() !== "") addRowAfter(index);
    } else if (event.key === "Backspace" && row.value === "" && rows.length > 1) {
      event.preventDefault();
      removeRow(index);
    }
  }

  return (
    <fieldset className="flex flex-col gap-2 p-4 pb-3">
      <legend className="sr-only">Project folders</legend>
      <p className="flex items-start gap-2 pb-1.5 text-sm leading-6 text-fg-muted">
        <Info aria-hidden="true" className="mt-[5px] size-3.5 shrink-0 text-fg-faint" />
        <span>
          Folder browsing needs the majhi host helper, which <InlineCommand command={RESTART_COMMAND} />{" "}
          installs.
        </span>
      </p>
      <div className="flex items-center justify-between pb-0.5">
        <span aria-hidden="true" className="text-sm text-fg-muted">
          Folders
        </span>
        <span className="flex items-center gap-1.5 text-xs text-fg-faint">
          <Kbd>Enter</Kbd> adds a row
        </span>
      </div>
      <ol className="flex flex-col gap-2">
        {rows.map((row, index) => {
          const showError = submitted || (touched.has(row.id) && row.value.trim() !== "");
          const error = showError ? check.rowErrors.get(row.id) : undefined;
          const errorId = `${formId}-root-${row.id}-error`;
          return (
            <li key={row.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <div className="relative min-w-0 flex-1">
                  <Folder
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-fg-faint"
                  />
                  <Input
                    ref={(el) => {
                      if (el) inputs.current.set(row.id, el);
                      else inputs.current.delete(row.id);
                    }}
                    value={row.value}
                    onChange={(e) => updateRow(row.id, e.target.value)}
                    onBlur={() => setTouched((prev) => new Set(prev).add(row.id))}
                    onKeyDown={(e) => onRowKeyDown(e, index, row)}
                    autoFocus={index === 0}
                    placeholder={index === 0 ? "~/Work" : "~/personal or /absolute/path"}
                    aria-label={`Project folder ${index + 1}`}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? errorId : undefined}
                    className="h-10 pl-9 font-mono"
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeRow(index)}
                  aria-label={`Remove project folder ${index + 1}`}
                  title="Remove"
                  disabled={rows.length === 1 && row.value === ""}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
              {error && (
                <p id={errorId} className="flex items-center gap-1.5 pl-1 text-sm text-red">
                  <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
                  {error}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      <div>
        <Button variant="ghost" size="sm" onClick={() => addRowAfter(rows.length - 1)} className="-ml-1">
          <Plus aria-hidden="true" />
          Add another folder
        </Button>
      </div>
      {submitted && check.formError && (
        <p role="alert" className="flex items-center gap-1.5 text-sm text-red">
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          {check.formError}
        </p>
      )}
    </fieldset>
  );
}
