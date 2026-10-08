import { collapseHome, hostOsOf, rootExample, type WorkspacesUpdateResult } from "@majhi/shared";
import { ChevronRight, CircleAlert } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { MOD_KEY } from "@/lib/format";
import { useHostStatus, useSetWorkspaces } from "@/lib/queries";
import { MissingFolders } from "./missing-folders";
import { checkRoots, defaultTasksDir, protectedRoots, type RootRow, type RootsDraft } from "./model";
import { ProtectedWarning } from "./protected-warning";
import { RootPicker } from "./root-picker";
import { TypedRoots } from "./typed-roots";

export interface RootsFormProps {
  mode: "first-run" | "edit";
  /** The owner's home on the host, for `~` in paths. */
  home: string;
  /** Absolute path of majhi.yaml. */
  file: string;
  initial: RootsDraft;
  onSaved: (result: WorkspacesUpdateResult) => void;
  onCancel?: () => void;
  /** Leave out the heading and the restart note, for a host that has its own (the onboarding journey). */
  bare?: boolean;
}

/** `body` gets the example root for the helper's OS, like `~/Work`. */
const COPY: Record<
  RootsFormProps["mode"],
  { title: string; body: (example: string) => string; submit: string }
> = {
  "first-run": {
    title: "Pick your project folders",
    body: (example) =>
      `A project folder holds your git repos, like ${example}. majhi finds every repo inside it.`,
    submit: "Save folders",
  },
  edit: {
    title: "Project folders",
    body: () => "majhi scans these folders for git repos.",
    submit: "Save changes",
  },
};

/**
 * The roots form for onboarding and `/settings/roots`. With the host helper connected the owner
 * picks folders (suggestions, browser); without it, this falls back to typed paths.
 */
export function RootsForm({ mode, home, file, initial, onSaved, onCancel, bare = false }: RootsFormProps) {
  const save = useSetWorkspaces(onSaved);
  const host = useHostStatus();
  const formId = useId();
  const [rows, setRows] = useState<RootRow[]>(() =>
    initial.rows.length > 0 ? initial.rows : [{ id: 0, value: "" }],
  );
  const [tasksDir, setTasksDir] = useState(initial.tasksDir);
  const [advancedOpen, setAdvancedOpen] = useState(initial.tasksDir !== "");
  const [submitted, setSubmitted] = useState(false);

  const nextId = useRef(Math.max(0, ...rows.map((r) => r.id)) + 1);
  const inputs = useRef(new Map<number, HTMLInputElement>());

  const check = useMemo(() => checkRoots({ rows, tasksDir }, home), [rows, tasksDir, home]);
  const protectedFound = useMemo(() => protectedRoots(rows, tasksDir, home), [rows, tasksDir, home]);
  const os = hostOsOf(host.data?.info);
  const example = rootExample(os);
  const firstRoot = rows.find((r) => r.value.trim() !== "")?.value ?? "";
  const tasksHint = defaultTasksDir(firstRoot || example);
  const copy = COPY[mode];
  // A failed status request means the server is down; typed paths still work once it is back.
  const helper = host.data
    ? host.data.connected
      ? "online"
      : "offline"
    : host.isError
      ? "offline"
      : "checking";
  const autoRemount = helper === "online" && host.data?.info?.canRemount === true;

  function newId() {
    return nextId.current++;
  }

  function addRoot(value: string) {
    const id = newId();
    setRows((prev) => [...prev.filter((r) => r.value.trim() !== ""), { id, value }]);
  }

  function removeRoot(id: number) {
    // The typed fallback needs a row to type into, so the last one turns blank instead.
    const blank = { id: newId(), value: "" };
    setRows((prev) => {
      const rest = prev.filter((r) => r.id !== id);
      return rest.length > 0 ? rest : [blank];
    });
  }

  /** `extra` is a root the picker added in the same keystroke, before `rows` has it. */
  function submit(event?: FormEvent, extra?: string) {
    event?.preventDefault();
    if (save.isPending) return;
    setSubmitted(true);
    const result =
      extra === undefined ? check : checkRoots({ rows: [...rows, { id: -1, value: extra }], tasksDir }, home);
    if (!result.input) {
      const firstBad = rows.find((r) => result.rowErrors.has(r.id));
      if (result.tasksDirError && !firstBad) setAdvancedOpen(true);
      if (firstBad) inputs.current.get(firstBad.id)?.focus();
      return;
    }
    save.mutate(result.input);
  }

  function onFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    // The folder browser and the path field use Esc and Cmd+Enter themselves.
    if (event.defaultPrevented) return;
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
      {!bare && (
        <div className="flex flex-col gap-2">
          <h1 className="text-lg font-semibold text-balance">{copy.title}</h1>
          <p className="text-base text-fg-muted text-pretty">{copy.body(example)}</p>
        </div>
      )}

      <form
        noValidate
        onSubmit={submit}
        onKeyDown={onFormKeyDown}
        aria-label="Project folders"
        className="flex flex-col rounded-xl border border-line-strong bg-card"
      >
        {helper === "online" ? (
          <RootPicker
            formId={formId}
            home={home}
            example={example}
            rows={rows}
            rowErrors={check.rowErrors}
            formError={submitted ? check.formError : undefined}
            onAdd={addRoot}
            onRemove={removeRoot}
            onSubmitWith={(value) => submit(undefined, value)}
          />
        ) : helper === "offline" ? (
          <TypedRoots
            formId={formId}
            example={example}
            rows={rows}
            setRows={setRows}
            newId={newId}
            check={check}
            submitted={submitted}
            inputs={inputs}
          />
        ) : (
          <PickerSkeleton />
        )}

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

        {os === "macos" && (
          <ProtectedWarning found={protectedFound} runtime={host.data?.info?.dockerRuntime} />
        )}

        {save.data?.missing !== undefined && (
          <div className="mx-4 mb-4">
            <MissingFolders save={save} />
          </div>
        )}

        {save.error && (
          <div role="alert" className="mx-4 mb-4 rounded-md border border-red-line bg-red-wash px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-base text-red">
              <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
              {save.error.unreachable
                ? "majhi is not responding. Your folders were not saved."
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

      {helper !== "checking" && !bare && (
        <p className="text-sm text-fg-faint text-pretty">
          {autoRemount
            ? "When you save, majhi restarts for a few seconds to mount new folders."
            : "majhi cannot restart itself from here. After you save a new folder, it shows the one command to run."}
        </p>
      )}
    </>
  );
}

function PickerSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3 p-4">
      <span className="sr-only">Checking for the majhi host helper</span>
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-10 w-full rounded-md" />
      <Skeleton className="h-7 w-36 rounded-md" />
    </div>
  );
}
