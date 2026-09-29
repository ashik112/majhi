import { collapseHome, type WorkspacesUpdateResult } from "@majhi/shared";
import { ChevronRight, CircleAlert, Folder, Plus, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/cn";
import { MOD_KEY } from "@/lib/format";
import { useSetWorkspaces } from "@/lib/queries";
import { checkRoots, defaultTasksDir, type RootRow, type RootsDraft } from "./model";

export interface RootsFormProps {
  mode: "first-run" | "edit";
  /** The owner's home on the host, for `~` in paths. */
  home: string;
  /** Absolute path of majhi.yaml. */
  file: string;
  initial: RootsDraft;
  onSaved: (result: WorkspacesUpdateResult) => void;
  onCancel?: () => void;
}

const COPY = {
  "first-run": {
    title: "Pick your workspace roots",
    body: "A workspace root is a folder that holds your git repos, like ~/Work. majhi finds every repo inside it.",
    submit: "Save roots",
  },
  edit: {
    title: "Workspace roots",
    body: "majhi scans these folders for git repos. Adding or removing a root needs a restart with make up.",
    submit: "Save changes",
  },
} as const;

export function RootsForm({ mode, home, file, initial, onSaved, onCancel }: RootsFormProps) {
  const save = useSetWorkspaces(onSaved);
  const formId = useId();
  const [rows, setRows] = useState<RootRow[]>(() =>
    initial.rows.length > 0 ? initial.rows : [{ id: 0, value: "" }],
  );
  const [tasksDir, setTasksDir] = useState(initial.tasksDir);
  const [advancedOpen, setAdvancedOpen] = useState(initial.tasksDir !== "");
  const [touched, setTouched] = useState<ReadonlySet<number>>(() => new Set());
  const [submitted, setSubmitted] = useState(false);

  const nextId = useRef(Math.max(0, ...rows.map((r) => r.id)) + 1);
  const inputs = useRef(new Map<number, HTMLInputElement>());
  const focusAfterRender = useRef<number | null>(null);

  const check = useMemo(() => checkRoots({ rows, tasksDir }, home), [rows, tasksDir, home]);
  const firstRoot = rows.find((r) => r.value.trim() !== "")?.value ?? "";
  const tasksHint = defaultTasksDir(firstRoot || "~/Work");
  const copy = COPY[mode];

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
      focusAfterRender.current = next.id;
      inputs.current.get(next.id)?.focus();
      return;
    }
    const id = nextId.current++;
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

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (save.isPending) return;
    setSubmitted(true);
    if (!check.input) {
      const firstBad = rows.find((r) => check.rowErrors.has(r.id)) ?? rows[0];
      if (check.tasksDirError && !firstBad) setAdvancedOpen(true);
      if (firstBad) inputs.current.get(firstBad.id)?.focus();
      return;
    }
    save.mutate(check.input);
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

  function onFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Escape" && onCancel) onCancel();
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  }

  const tasksDirError = submitted || tasksDir.trim() !== "" ? check.tasksDirError : undefined;
  const showAdvanced = advancedOpen || tasksDirError !== undefined;

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold text-balance">{copy.title}</h1>
        <p className="text-base text-fg-muted text-pretty">{copy.body}</p>
      </div>

      <form
        noValidate
        onSubmit={submit}
        onKeyDown={onFormKeyDown}
        aria-labelledby={`${formId}-legend`}
        className="flex flex-col rounded-xl border border-line-strong bg-panel"
      >
        <fieldset className="flex flex-col gap-2 p-4 pb-3">
          <legend id={`${formId}-legend`} className="sr-only">
            Workspace roots
          </legend>
          <div className="flex items-center justify-between pb-0.5">
            <span aria-hidden="true" className="text-sm text-fg-muted">
              Roots
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
                        aria-label={`Workspace root ${index + 1}`}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? errorId : undefined}
                        className="h-10 pl-9 font-mono"
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeRow(index)}
                      aria-label={`Remove workspace root ${index + 1}`}
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
              Add another root
            </Button>
          </div>
          {submitted && check.formError && (
            <p role="alert" className="flex items-center gap-1.5 text-sm text-red">
              <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
              {check.formError}
            </p>
          )}
        </fieldset>

        <div className="border-t border-line">
          <button
            type="button"
            aria-expanded={showAdvanced}
            aria-controls={`${formId}-advanced`}
            onClick={() => setAdvancedOpen(!showAdvanced)}
            className="flex h-10 w-full cursor-pointer items-center gap-1.5 px-4 text-sm text-fg-muted transition-colors hover:text-fg"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn("size-3.5 transition-transform duration-150", showAdvanced && "rotate-90")}
            />
            Advanced
          </button>
          {showAdvanced && (
            <div id={`${formId}-advanced`} className="flex flex-col gap-1.5 px-4 pb-4">
              <label htmlFor={`${formId}-tasks`} className="text-sm text-fg-muted">
                Tasks folder
              </label>
              <Input
                id={`${formId}-tasks`}
                value={tasksDir}
                onChange={(e) => setTasksDir(e.target.value)}
                placeholder={tasksHint}
                aria-invalid={tasksDirError ? true : undefined}
                aria-describedby={`${formId}-tasks-hint`}
                className="h-10 font-mono"
              />
              <p
                id={`${formId}-tasks-hint`}
                className={cn("text-sm", tasksDirError ? "text-red" : "text-fg-faint")}
              >
                {tasksDirError ?? (
                  <>
                    Where task folders and worktrees go. Blank means{" "}
                    <span className="font-mono text-fg-muted">{tasksHint}</span>.
                  </>
                )}
              </p>
            </div>
          )}
        </div>

        {save.error && (
          <div role="alert" className="mx-4 mb-4 rounded-md border border-red-line bg-red-wash px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-base text-red">
              <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
              {save.error.unreachable
                ? "majhi is not responding. Your roots were not saved."
                : save.error.message}
            </p>
            {save.error.details.length > 0 && (
              <ul className="mt-1 flex flex-col gap-0.5 pl-5 font-mono text-sm text-fg-soft">
                {save.error.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
          <p className="min-w-0 truncate text-sm text-fg-faint">
            Saved to <span className="font-mono text-fg-muted">{collapseHome(file, home)}</span>
          </p>
          <div className="ml-auto flex items-center gap-2">
            {onCancel && (
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            )}
            <Button type="submit" variant="primary" disabled={save.isPending}>
              {save.isPending ? "Saving" : copy.submit}
              <Kbd>{MOD_KEY} Enter</Kbd>
            </Button>
          </div>
        </div>
      </form>

      {mode === "first-run" && (
        <p className="text-sm text-fg-faint text-pretty">
          majhi mounts each root into its container when it starts, so a new root needs a restart. You get the
          command after you save.
        </p>
      )}
    </>
  );
}
