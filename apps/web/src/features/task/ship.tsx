import type { ShipOption, Task } from "@majhi/shared";
import { ChevronDown, GitMerge, LoaderCircle } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cmd } from "@/lib/api";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useAfterTaskChange, useShipOptions, useTaskBranches } from "@/lib/task-queries";

export type ShipAction = "merge" | "mergePush" | "push" | "mr";
export interface ShipResult {
  project: string;
  into: string;
  ok: boolean;
  detail: string;
}
/** Runs one Ship action: straight through its command, or through a review card's button. */
export type RunShip = (action: ShipAction, into: string) => Promise<{ results?: ShipResult[] | undefined }>;

const ACTIONS: readonly ShipAction[] = ["merge", "mergePush", "push", "mr"];
const PANEL_WIDTH = 400;
const GAP = 16;

/**
 * Where the panel goes: fixed to the viewport so a scrolling room never clips it, below the button
 * when there is room, else above it, and kept inside the window.
 */
function placeNear(button: HTMLElement, align: "left" | "right"): CSSProperties {
  const r = button.getBoundingClientRect();
  const width = Math.min(PANEL_WIDTH, window.innerWidth - 2 * GAP);
  const left =
    align === "left"
      ? Math.min(r.left, window.innerWidth - width - GAP)
      : Math.max(GAP, Math.min(r.right - width, window.innerWidth - width - GAP));
  const below = window.innerHeight - r.bottom - GAP;
  const above = r.top - GAP;
  const vertical =
    below >= 440 || below >= above
      ? { top: r.bottom + 4, maxHeight: below - 4 }
      : { bottom: window.innerHeight - r.top + 4, maxHeight: above - 4 };
  return { position: "fixed", left, width, ...vertical };
}

/** Ship straight through the task commands (the header). A merge from review marks the task done. */
export function useDirectShip(task: Task): RunShip {
  const after = useAfterTaskChange();
  return async (action, into) => {
    if (action === "merge" || action === "mergePush") {
      const out = await cmd("tasks.merge", {
        id: task.id,
        into,
        done: task.status === "review",
        push: action === "mergePush",
      });
      await after(out.task);
      return out;
    }
    if (action === "push") {
      const out = await cmd("tasks.push", { id: task.id });
      await after(out.task);
      return out;
    }
    const out = await cmd("tasks.openMrs", { id: task.id, into });
    await after(out.task);
    return {
      results: out.repos.map((r) => ({
        project: r.project,
        into,
        ok: r.outcome !== "failed",
        detail: r.detail,
      })),
    };
  };
}

/**
 * Ship: pick a branch, then merge into it locally, merge and push it, push the task branch, or push
 * and open merge requests into it. Each action says why when it cannot run now.
 */
export function Ship({
  task,
  run,
  align = "right",
  variant = "secondary",
}: {
  task: Task;
  run: RunShip;
  align?: "left" | "right";
  variant?: "primary" | "secondary";
}) {
  const [place, setPlace] = useState<CSSProperties>();
  const open = place !== undefined;
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const setOpen = (next: boolean) =>
    setPlace(next && trigger.current ? placeNear(trigger.current, align) : undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: set up once per opening
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const t = event.target;
      if (t instanceof Node && !root.current?.contains(t) && !panel.current?.contains(t)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !open) return;
    // Esc closes the panel; it must not also stop the room's agent.
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only catches Esc from inside the panel
    <div ref={root} className="relative" onKeyDown={onKeyDown}>
      <Button
        ref={trigger}
        size="sm"
        variant={variant}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <GitMerge aria-hidden="true" />
        Ship
        <ChevronDown aria-hidden="true" />
      </Button>
      {place !== undefined && (
        <ShipPanel
          id={id}
          task={task}
          run={run}
          place={place}
          panelRef={panel}
          onClose={() => {
            setOpen(false);
            trigger.current?.focus();
          }}
        />
      )}
    </div>
  );
}

function ShipPanel({
  id,
  task,
  run,
  place,
  panelRef,
  onClose,
}: {
  id: string;
  task: Task;
  run: RunShip;
  place: CSSProperties;
  panelRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const options = useShipOptions(task, true);
  const branches = useTaskBranches(task.id, true);
  const base = options.data?.base ?? task.repos[0]?.base ?? "main";
  const [into, setInto] = useState(base);
  const [chosen, setChosen] = useState<ShipAction>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [results, setResults] = useState<ShipResult[]>();

  const local = [...new Set([base, ...(branches.data ?? []).flatMap((r) => r.branches)])];
  const remote = [...new Set((branches.data ?? []).flatMap((r) => r.remote))].filter(
    (b) => !local.includes(b),
  );
  const request = options.data?.host === "github" ? "pull request" : "merge request";
  const done = task.status === "review";
  const branch = task.repos.map((r) => r.branch).join(", ");

  const labels: Record<ShipAction, { title: string; hint: string; confirm: string; summary: string }> = {
    merge: {
      title: `Merge into ${into}`,
      hint: "In your checkout. Nothing is pushed.",
      confirm: "Merge",
      summary: `Merge ${branch} into ${into} in your checkout${done ? " and mark the task done" : ""}. Nothing is pushed.`,
    },
    mergePush: {
      title: `Merge into ${into} and push ${into}`,
      hint: `Then pushes ${into} to the remote. Never forced.`,
      confirm: "Merge and push",
      summary: `Merge ${branch} into ${into}, then push ${into}${done ? ", and mark the task done" : ""}. Refused if the remote's ${into} has commits yours lacks.`,
    },
    push: {
      title: "Push the task branch",
      hint: `Only the push. No ${request} is opened.`,
      confirm: "Push",
      summary: `Push ${branch} to the remote. No ${request} is opened.`,
    },
    mr: {
      title: `Push and open a ${request} into ${into}`,
      hint: "One per repo. Nothing merges yet.",
      confirm: `Open ${request}`,
      summary: `Push ${branch} and open a ${request} into ${into} for each repo.`,
    },
  };

  function optionOf(action: ShipAction): ShipOption | undefined {
    const o = options.data?.[action];
    if (o === undefined) return undefined;
    if (o.ok && (action === "merge" || action === "mergePush") && !local.includes(into)) {
      return { ok: false, why: `${into} is not a local branch. Pick a local one to merge into.` };
    }
    return o;
  }

  async function confirm(action: ShipAction) {
    setBusy(true);
    setError(undefined);
    try {
      const out = await run(action, into);
      const list = out.results ?? [];
      if (list.length > 0 && list.every((r) => r.ok) && action !== "push") onClose();
      else setResults(list);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  // In a portal: a room that scrolls, or content-visibility on a room item, would clip it.
  return createPortal(
    <section
      ref={panelRef}
      id={id}
      role="dialog"
      aria-label={`Ship ${task.id}`}
      style={place}
      className="z-50 flex flex-col gap-2.5 overflow-y-auto rounded-lg border border-line-bright bg-card p-3 shadow-pop"
    >
      <div className="flex items-center gap-2 text-sm">
        <label htmlFor={`${id}-into`} className="shrink-0 text-fg-muted">
          Into
        </label>
        <Select
          id={`${id}-into`}
          value={into}
          disabled={busy}
          onChange={(e) => {
            setInto(e.target.value);
            setResults(undefined);
          }}
          className="h-8 font-mono text-sm"
        >
          <optgroup label="Local">
            {local.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </optgroup>
          {remote.length > 0 && (
            <optgroup label="Remote only">
              {remote.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </div>
      {options.isError && (
        <p role="alert" className="text-sm text-red text-pretty">
          {describeError(options.error)}
        </p>
      )}
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {ACTIONS.map((action) => {
          const o = optionOf(action);
          const label = labels[action];
          const disabled = o === undefined || !o.ok || busy;
          return (
            <li key={action}>
              <button
                type="button"
                aria-disabled={disabled}
                aria-pressed={chosen === action}
                onClick={() => {
                  if (disabled) return;
                  setChosen(action);
                  setResults(undefined);
                  setError(undefined);
                }}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 rounded-md border px-2.5 py-1.5 text-left",
                  chosen === action ? "border-accent-line bg-accent-wash" : "border-transparent",
                  disabled ? "cursor-default" : "cursor-pointer hover:bg-raised",
                )}
              >
                <span className={cn("text-base", disabled ? "text-fg-faint" : "text-fg")}>{label.title}</span>
                <span className={cn("text-xs text-pretty", o?.ok === false ? "text-amber" : "text-fg-faint")}>
                  {o === undefined ? "Checking..." : o.ok ? label.hint : o.why}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {chosen !== undefined && results === undefined && (
        <div className="flex flex-col gap-2 border-t border-line pt-2.5">
          <p className="text-sm text-fg-muted text-pretty">{labels[chosen].summary}</p>
          {error && (
            <p role="alert" className="text-sm text-red text-pretty">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setChosen(undefined)}>
              Back
            </Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void confirm(chosen)}>
              {busy && <LoaderCircle aria-hidden="true" className="animate-spin" />}
              {busy ? "Working" : labels[chosen].confirm}
            </Button>
          </div>
        </div>
      )}
      {results !== undefined && (
        <div className="flex flex-col gap-2 border-t border-line pt-2.5">
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
            {results.map((r) => (
              <li key={r.project} className={cn(r.ok ? "text-green" : "text-red", "text-pretty")}>
                {task.repos.length > 1 && <span className="font-mono">{r.project}: </span>}
                {r.detail}
              </li>
            ))}
          </ul>
          <Button size="sm" className="self-end" onClick={onClose}>
            Close
          </Button>
        </div>
      )}
    </section>,
    document.body,
  );
}
