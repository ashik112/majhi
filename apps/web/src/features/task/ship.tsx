import {
  type MergeMethod,
  mergeCanBeOverridden,
  mergeVerdictLine,
  type ShipFix,
  type ShipOption,
  shipWords,
  type Task,
} from "@majhi/shared";
import { ArrowRight, ChevronDown, GitBranch, GitMerge, LoaderCircle, Lock, Wrench } from "lucide-react";
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
import { PageLink } from "@/components/ui/page-link";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ChecksOnCommit } from "@/features/handoff/checks-on-commit";
import { GitLoginOffer } from "@/features/orgs/git-login-offer";
import { cmd } from "@/lib/api";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useHandoff } from "@/lib/handoff-queries";
import { useAfterTaskChange, useShipOptions, useTaskBranches } from "@/lib/task-queries";

export type ShipAction = "merge" | "mergePush" | "push" | "mr";
export interface ShipResult {
  project: string;
  into: string;
  ok: boolean;
  detail: string;
  conflicts?: string[] | undefined;
  /** No change in this repo since the task started: nothing was done in it. */
  skipped?: boolean | undefined;
  /** Merged locally, but the push failed. */
  notPushed?: boolean | undefined;
}
/** Where the changed repos ship: one branch for all, or one per repo. */
export type ShipTarget = { into: string } | { targets: Record<string, string> };
export interface ShipChoices {
  /** For merge and mergePush. */
  method: MergeMethod;
  /** For merge, mergePush and push. */
  deleteAfter: boolean;
  /** For mergePush: the owner confirmed sending local commits on the target that are not the task's. */
  pushLocalCommits?: boolean | undefined;
  /** For mergePush: the owner confirmed creating the target branch on the remote. */
  createRemoteBranch?: boolean | undefined;
  /** For merge and mergePush: the owner merges past a failed check by sending the head the options name. */
  confirmChecks?: string | undefined;
}
/** Runs one Ship action: straight through its command, or through a review card's button. */
export type RunShip = (
  action: ShipAction,
  target: ShipTarget,
  choices: ShipChoices,
) => Promise<{ results?: ShipResult[] | undefined }>;

/** Refusals the owner can confirm past (the server's CONFIRM_EXTRA and CONFIRM_NEW). */
const ASKS_EXTRA = "Pushing would send them with the task.";
const ASKS_NEW = "Pushing would create it there.";

/** The refusal for a local target branch that is behind its remote; the first group is the remote's name. */
const REMOTE_AHEAD = /^(\S+)\/\S+ has commits that your local \S+ in \S+ does not have\./;

const ACTIONS: readonly ShipAction[] = ["merge", "mergePush", "push", "mr"];
const MERGES: readonly ShipAction[] = ["merge", "mergePush"];
const PANEL_WIDTH = 440;
const GAP = 16;
const METHOD_KEY = "majhi.ship.method";

const METHODS = [
  { value: "merge", label: "Merge commit" },
  { value: "squash", label: "Squash" },
  { value: "rebase", label: "Rebase" },
] as const satisfies readonly { value: MergeMethod; label: string }[];

/** The method picked last time, in this browser. */
function savedMethod(): MergeMethod {
  try {
    const saved = localStorage.getItem(METHOD_KEY);
    return METHODS.find((m) => m.value === saved)?.value ?? "merge";
  } catch {
    return "merge";
  }
}

function saveMethod(method: MergeMethod): void {
  try {
    localStorage.setItem(METHOD_KEY, method);
  } catch {
    // Private windows and blocked storage: the choice lasts until the panel closes.
  }
}

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
    below >= 480 || below >= above
      ? { top: r.bottom + 4, maxHeight: below - 4 }
      : { bottom: window.innerHeight - r.top + 4, maxHeight: above - 4 };
  return { position: "fixed", left, width, ...vertical };
}

/**
 * Ship straight through the task commands (the header). A merge from review marks the task done;
 * a done task stays done and an open one stays open.
 */
export function useDirectShip(task: Task): RunShip {
  const after = useAfterTaskChange();
  return async (
    action,
    target,
    { method, deleteAfter, pushLocalCommits, createRemoteBranch, confirmChecks },
  ) => {
    if (action === "merge" || action === "mergePush") {
      const out = await cmd("tasks.merge", {
        id: task.id,
        ...target,
        done: task.status === "review",
        push: action === "mergePush",
        method,
        deleteAfter,
        pushLocalCommits: pushLocalCommits === true,
        createRemoteBranch: createRemoteBranch === true,
        ...(confirmChecks === undefined ? {} : { confirmChecks }),
      });
      await after(out.task);
      return out;
    }
    if (action === "push") {
      const out = await cmd("tasks.push", { id: task.id, deleteAfter });
      await after(out.task);
      return out;
    }
    const out = await cmd("tasks.openMrs", { id: task.id, ...target });
    await after(out.task);
    return {
      results: out.repos.map((r) => ({
        project: r.project,
        into: "targets" in target ? (target.targets[r.project] ?? "") : target.into,
        ok: r.outcome !== "failed",
        detail: r.detail,
      })),
    };
  };
}

/**
 * Ship: the task branch into a target branch. Merge it locally (merge commit, squash or rebase),
 * merge and push, push the task branch, or push and open merge requests. Each action says why when
 * it cannot run now, with a link to the fix when it is on another page.
 */
export function Ship({
  task,
  run,
  lead,
  align = "right",
  variant = "secondary",
  primaryAction = false,
  openAsk = 0,
}: {
  task: Task;
  run: RunShip;
  /** Who gets the conflicts to resolve. Default: the task's first agent. */
  lead?: string | undefined;
  align?: "left" | "right";
  variant?: "primary" | "secondary";
  /** The task's one main action, which the approve shortcut clicks. */
  primaryAction?: boolean;
  /** Counts up each time something outside asks for the panel to open. */
  openAsk?: number;
}) {
  const [place, setPlace] = useState<CSSProperties>();
  const open = place !== undefined;
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const setOpen = (next: boolean) =>
    setPlace(next && trigger.current ? placeNear(trigger.current, align) : undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new ask opens it
  useEffect(() => {
    if (openAsk > 0 && trigger.current) setPlace(placeNear(trigger.current, align));
  }, [openAsk]);

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
        {...(primaryAction ? { "data-primary-action": "" } : {})}
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
          lead={lead ?? task.team[0]}
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

/** The task branch of the repos that ship, or each repo's when they differ, in mono. */
function SourceBranches({ repos }: { repos: readonly { project: string; branch: string }[] }) {
  const names = [...new Set(repos.map((r) => r.branch))];
  if (names.length <= 1) {
    const name = names[0] ?? "";
    return (
      <span
        title={name}
        className="flex h-8 min-w-0 flex-[3] items-center gap-1.5 rounded-md border border-line-strong bg-sunken px-2.5"
      >
        <GitBranch aria-hidden="true" className="size-3.5 shrink-0 text-fg-faint" />
        <span className="min-w-0 truncate font-mono text-sm text-fg">{name}</span>
      </span>
    );
  }
  return (
    <ul className="m-0 flex min-w-0 flex-[3] list-none flex-col gap-1 p-0">
      {repos.map((r) => (
        <li
          key={r.project}
          title={`${r.project}: ${r.branch}`}
          className="flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-line-strong bg-sunken px-2.5 text-sm"
        >
          <span className="shrink-0 text-fg-faint">{r.project}</span>
          <span className="min-w-0 truncate font-mono text-fg">{r.branch}</span>
        </li>
      ))}
    </ul>
  );
}

/** A link to the page where the owner fixes what blocks an action. */
function FixLink({ fix, onGo }: { fix: ShipFix; onGo: () => void }) {
  const common = "inline-flex items-center gap-1 text-xs text-blue underline-offset-2 hover:underline";
  if (fix.page === "projects") {
    return (
      <PageLink
        page="projects"
        search={{ project: fix.project, section: "remotes" }}
        className={common}
        onClick={onGo}
      >
        <Wrench aria-hidden="true" className="size-3" />
        Fix it in Projects: <span className="font-mono">{fix.project}</span>
      </PageLink>
    );
  }
  return (
    <PageLink page="orgs" search={{ org: fix.org }} className={common} onClick={onGo}>
      <Wrench aria-hidden="true" className="size-3" />
      Fix it in Workspaces
    </PageLink>
  );
}

function ShipPanel({
  id,
  task,
  run,
  lead,
  place,
  panelRef,
  onClose,
}: {
  id: string;
  task: Task;
  run: RunShip;
  lead: string | undefined;
  place: CSSProperties;
  panelRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const options = useShipOptions(task, true);
  const after = useAfterTaskChange();
  const handoff = useHandoff(task.id, task.repos.length > 0).data;
  const branches = useTaskBranches(task.id, true);
  const base = options.data?.base ?? task.repos[0]?.base ?? "main";
  // Ship sends only the repos the task changed; the rest are skipped and listed.
  const changed =
    options.data?.changed ?? task.repos.map((r) => ({ project: r.project, base: r.base, branch: r.branch }));
  const unchanged = options.data?.unchanged ?? [];
  // Protected repos never ship with the others: each has its own row and ships alone.
  const guarded = options.data?.protected ?? [];
  const others = changed.length > 0;
  // Repos on different bases each get their own target, their base by default.
  const perRepo = new Set(changed.map((r) => r.base)).size > 1;
  const [into, setInto] = useState(base);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const targets = Object.fromEntries(changed.map((r) => [r.project, picked[r.project] ?? r.base]));
  const target: ShipTarget = perRepo ? { targets } : { into };
  const intoText = perRepo ? [...new Set(Object.values(targets))].join(", ") : into;
  const [chosen, setChosen] = useState<ShipAction>();
  const [method, setMethod] = useState<MergeMethod>(savedMethod);
  const [deleteAfter, setDeleteAfter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [results, setResults] = useState<ShipResult[]>();
  // Set when a push was refused because the remote's branch is ahead of the local one.
  const [behind, setBehind] = useState<{ remote: string; into: string }>();
  // Set when a push would also send commits that are not the task's, or create the target branch.
  const [asks, setAsks] = useState<{ extra: boolean; create: boolean }>();

  const local = [...new Set([base, ...(branches.data ?? []).flatMap((r) => r.branches)])];
  const remote = [...new Set((branches.data ?? []).flatMap((r) => r.remote))].filter(
    (b) => !local.includes(b),
  );
  const request = options.data?.host === "github" ? "pull request" : "merge request";
  const closes = task.status === "review";
  const branch = [...new Set(changed.map((r) => r.branch))].join(", ");
  const created = task.repos.some((r) => r.createdBranch);
  // The merge rule: a local merge goes through only when the checks are green for this exact commit.
  const checks = options.data?.checks;
  const verdict = checks?.verdict;
  const running = verdict?.kind === "running";
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the running state starts the polling
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void options.refetch(), 2_000);
    return () => clearInterval(timer);
  }, [running]);

  const verb = method === "squash" ? "Squash" : method === "rebase" ? "Rebase" : "Merge";
  const how =
    method === "squash"
      ? `One new commit on ${intoText}. The task branch stays as it is.`
      : method === "rebase"
        ? `Replays the task's commits on top of ${intoText}, then fast-forwards ${intoText}. It never rewrites ${intoText}.`
        : "Fast-forward when it can, else a merge commit.";
  const landing =
    method === "rebase"
      ? `Rebase ${branch} onto ${intoText}, then fast-forward ${intoText}`
      : `${verb} ${branch} into ${intoText}`;

  const labels: Record<ShipAction, { title: string; hint: string; confirm: string; summary: string }> = {
    merge: {
      title: `Merge into ${intoText}`,
      hint: "In your checkout. Nothing is pushed.",
      confirm: verb,
      summary: `${landing} in your checkout${closes ? ", and mark the task done" : ""}. Nothing is pushed.`,
    },
    mergePush: {
      title: `Merge into ${intoText} and push ${intoText}`,
      hint: `Then pushes ${intoText} to the remote. Never forced.`,
      confirm: `${verb} and push`,
      summary: `${landing}, then push ${intoText}${closes ? ", and mark the task done" : ""}. Refused if the remote's ${intoText} has commits yours lacks.`,
    },
    push: {
      title: "Push the task branch",
      hint: `Only the push. No ${request} is opened.`,
      confirm: "Push",
      summary: `Push ${branch} to the remote. No ${request} is opened.`,
    },
    mr: {
      title: `Push and open a ${request} into ${intoText}`,
      hint: "One per repo. Nothing merges yet.",
      confirm: `Open ${request}`,
      summary: `Push ${branch} and open a ${request} into ${intoText} for each repo.`,
    },
  };

  function optionOf(action: ShipAction): ShipOption | undefined {
    const o = options.data?.[action];
    if (o === undefined) return undefined;
    if (o.ok && MERGES.includes(action)) {
      const missing = perRepo
        ? changed.find((r) => {
            const own = branches.data?.find((b) => b.project === r.project);
            const name = targets[r.project] ?? r.base;
            return own !== undefined && name !== own.base && !own.branches.includes(name);
          })
        : undefined;
      if (missing !== undefined) {
        return {
          ok: false,
          why: `${targets[missing.project]} is not a local branch in ${missing.project}. Pick a local one to merge into.`,
        };
      }
      if (!perRepo && !local.includes(into)) {
        return { ok: false, why: `${into} is not a local branch. Pick a local one to merge into.` };
      }
    }
    return o;
  }

  async function confirm(
    action: ShipAction,
    confirmed?: { extra: boolean; create: boolean },
    confirmChecks?: string,
  ) {
    setBusy(true);
    setError(undefined);
    setBehind(undefined);
    setAsks(undefined);
    const deleting = deleteAfter && action !== "mr";
    try {
      const out = await run(action, target, {
        method,
        deleteAfter: deleting,
        pushLocalCommits: confirmed?.extra,
        createRemoteBranch: confirmed?.create,
        confirmChecks,
      });
      const list = out.results ?? [];
      // A clean run closes; the room says what merged and, with "delete after", what was deleted.
      if (list.length > 0 && list.every((r) => r.ok) && action !== "push") onClose();
      else setResults(list);
    } catch (err) {
      const message = describeError(err);
      const remote = REMOTE_AHEAD.exec(message)?.[1];
      if (remote !== undefined) setBehind({ remote, into: intoText });
      const extra = message.includes(ASKS_EXTRA);
      const create = message.includes(ASKS_NEW);
      if (remote === undefined && (extra || create)) setAsks({ extra, create });
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  /** Merge by itself when the checks of this exact commit pass, through the same merge rule. */
  async function mergeWhenChecksPass(action: ShipAction) {
    if (action !== "merge" && action !== "mergePush") return;
    setBusy(true);
    setError(undefined);
    try {
      await cmd("tasks.queueMerge", { id: task.id, action, ...target, method, deleteAfter });
      await after();
      onClose();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  async function cancelQueued() {
    setBusy(true);
    setError(undefined);
    try {
      await cmd("tasks.cancelQueuedMerge", { id: task.id });
      await after();
      await options.refetch();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  /** Runs the hand-off checks for the head now: the verdict turns to running, then green or red. */
  async function runChecks() {
    setBusy(true);
    setError(undefined);
    try {
      await cmd(
        "handoff.check",
        { task: task.id, force: false },
        { reason: "Owner asked to run the checks before merging" },
      );
      await options.refetch();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  /** Sends the failed check back to the task's agent. */
  async function fixWithAgent(text: string) {
    setBusy(true);
    setError(undefined);
    try {
      await cmd("room.send", {
        task: task.id,
        text,
      });
      onClose();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  /** Fast-forwards the local target branch from its remote, then runs the same ship again. */
  async function updateAndShip(action: ShipAction) {
    setBusy(true);
    setError(undefined);
    try {
      const out = await cmd("tasks.updateTarget", { id: task.id, ...target });
      const refused = out.results.filter((r) => !r.ok);
      if (refused.length > 0) {
        setBehind(undefined);
        setError(refused.map((r) => r.detail).join(" "));
        setBusy(false);
        return;
      }
    } catch (err) {
      setBehind(undefined);
      setError(describeError(err));
      setBusy(false);
      return;
    }
    setBehind(undefined);
    await confirm(action);
  }

  const conflicted = (results ?? []).filter((r) => (r.conflicts ?? []).length > 0);
  const notPushed = (results ?? []).filter((r) => r.notPushed === true);

  // In a portal: a room that scrolls, or content-visibility on a room item, would clip it.
  return createPortal(
    <section
      ref={panelRef}
      id={id}
      role="dialog"
      aria-label={`Ship ${task.id}`}
      style={place}
      className="z-50 flex flex-col gap-3 overflow-y-auto rounded-lg border border-line-bright bg-glass-strong p-3 shadow-pop"
    >
      {!others ? null : perRepo ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {changed.map((r) => {
            const own = branches.data?.find((b) => b.project === r.project);
            const names = [...new Set([r.base, ...(own?.branches ?? [])])];
            const value = targets[r.project] ?? r.base;
            return (
              <li key={r.project} className="flex items-center gap-2">
                <span
                  title={`${r.project}: ${r.branch}`}
                  className="flex h-8 min-w-0 flex-[3] items-center gap-1.5 rounded-md border border-line-strong bg-sunken px-2.5 text-sm"
                >
                  <span className="shrink-0 text-fg-faint">{r.project}</span>
                  <span className="min-w-0 truncate font-mono text-fg">{r.branch}</span>
                </span>
                <ArrowRight role="img" aria-label="into" className="size-4 shrink-0 text-fg-faint" />
                <Select
                  aria-label={`Target branch for ${r.project}`}
                  value={value}
                  disabled={busy}
                  onChange={(e) => {
                    const next = e.target.value;
                    setPicked((p) => ({ ...p, [r.project]: next }));
                    setResults(undefined);
                  }}
                  title={value}
                  className="h-8 min-w-0 flex-[2] font-mono text-sm"
                >
                  {names.map((b) => (
                    <option key={b} value={b}>
                      {b === r.base ? `${b} (base)` : b}
                    </option>
                  ))}
                </Select>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex items-start gap-2">
          <SourceBranches repos={changed} />
          <ArrowRight role="img" aria-label="into" className="mt-2 size-4 shrink-0 text-fg-faint" />
          <Select
            aria-label="Target branch"
            value={into}
            disabled={busy}
            onChange={(e) => {
              setInto(e.target.value);
              setResults(undefined);
            }}
            title={into}
            className="h-8 min-w-0 flex-[2] font-mono text-sm"
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
      )}
      {unchanged.length > 0 && (
        <p className="text-xs text-fg-faint text-pretty">
          No changes, skipped: <span className="font-mono">{unchanged.join(", ")}</span>.
        </p>
      )}
      {guarded.map((g) => (
        <ProtectedRow
          key={g.project}
          task={task}
          repo={g}
          method={method}
          disabled={busy}
          onResults={(list) => {
            setChosen(undefined);
            setResults(list);
          }}
        />
      ))}
      {options.isError && (
        <p role="alert" className="text-sm text-red text-pretty">
          {describeError(options.error)}
        </p>
      )}
      {others && verdict !== undefined && (
        <p
          className={cn(
            "flex items-start gap-1.5 text-xs text-pretty",
            verdict.kind === "ok" ? "text-fg-faint" : "text-amber",
          )}
        >
          {verdict.kind === "running" && (
            <LoaderCircle aria-hidden="true" className="mt-0.5 size-3 shrink-0 animate-spin" />
          )}
          {verdict.kind === "running" ? (
            <span>
              <ChecksOnCommit
                step={handoff?.activity?.phase === "running" ? handoff.activity.step : undefined}
              />
              . Not ready to merge until they pass.
            </span>
          ) : (
            <span>{mergeVerdictLine(verdict)}</span>
          )}
        </p>
      )}
      {others && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {ACTIONS.map((action, i) => {
            const o = optionOf(action);
            const label = labels[action];
            const disabled = o === undefined || !o.ok || busy;
            // One reason that blocks several actions (no git account for the host) is said once, with its fix.
            const repeated = o?.ok === false && ACTIONS.slice(0, i).some((a) => optionOf(a)?.why === o.why);
            return (
              <li key={action} className="flex flex-col">
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
                  <span className={cn("text-base", disabled ? "text-fg-faint" : "text-fg")}>
                    {label.title}
                  </span>
                  <span
                    className={cn(
                      "text-xs text-pretty",
                      o?.ok === false && !repeated ? "text-amber" : "text-fg-faint",
                    )}
                  >
                    {o === undefined
                      ? "Checking..."
                      : o.ok
                        ? label.hint
                        : repeated
                          ? "Same reason as above."
                          : o.why}
                  </span>
                </button>
                {o?.ok === false && o.fix !== undefined && !repeated && (
                  <span className="px-2.5 pb-1">
                    <FixLink fix={o.fix} onGo={onClose} />
                    {o.fix.page === "orgs" && action === "mr" && (
                      <span className="mt-1 flex flex-col gap-1">
                        <GitLoginOffer org={o.fix.org} orgName={o.fix.org} host={options.data?.host} />
                      </span>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {chosen !== undefined && results === undefined && (
        <div className="flex flex-col gap-2.5 border-t border-line pt-3">
          {MERGES.includes(chosen) && (
            <div className="flex flex-col gap-1.5">
              <Segmented
                label="How to merge"
                value={method}
                segments={METHODS}
                onChange={(next) => {
                  setMethod(next);
                  saveMethod(next);
                }}
                className="self-start"
              />
              <p className="text-xs text-fg-faint text-pretty">{how}</p>
            </div>
          )}
          {chosen !== "mr" && (
            <div className="flex flex-col">
              <Switch
                label="Delete the task branch and its worktree after"
                checked={deleteAfter}
                disabled={busy}
                onChange={setDeleteAfter}
              />
              {deleteAfter && (
                <p className="text-xs text-fg-faint text-pretty">
                  {created
                    ? "Only once it all worked. A worktree with uncommitted changes stops the action."
                    : `Only the worktree: majhi did not create ${branch}, so it stays.`}
                  {chosen === "push" && " The remote branch stays."}
                </p>
              )}
            </div>
          )}
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
            {MERGES.includes(chosen) &&
            verdict !== undefined &&
            checks !== undefined &&
            verdict.kind !== "ok" ? (
              <>
                {verdict.kind === "stale" && (
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => void runChecks()}>
                    {busy && <LoaderCircle aria-hidden="true" className="animate-spin" />}
                    Run checks
                  </Button>
                )}
                {verdict.kind === "failed" && (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    onClick={() =>
                      void fixWithAgent(
                        `The ${verdict.check} check failed on your latest commit, so it cannot merge. Read the failure with the hand-off tool, fix it and commit.`,
                      )
                    }
                  >
                    Fix with agent
                  </Button>
                )}
                {/* Only the owner clears it (a card waits for them): the lead is not asked to fix it. */}
                {verdict.kind === "blocked" && verdict.owner === true && (
                  <p className="self-center text-xs text-amber text-pretty">{mergeVerdictLine(verdict)}</p>
                )}
                {verdict.kind === "blocked" && verdict.owner !== true && (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    onClick={() =>
                      void fixWithAgent(
                        `Your branch cannot merge yet: ${verdict.why}. Fix it (for a conflict, run tasks.syncBase, or merge the base and resolve it), commit, and say when it is done.`,
                      )
                    }
                  >
                    Fix with agent
                  </Button>
                )}
                {verdict.kind === "running" && options.data?.queued !== undefined && (
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => void cancelQueued()}>
                    Cancel: will merge when checks pass
                  </Button>
                )}
                {verdict.kind === "running" && options.data?.queued === undefined && (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    onClick={() => void mergeWhenChecksPass(chosen)}
                  >
                    {busy ? (
                      <LoaderCircle aria-hidden="true" className="animate-spin" />
                    ) : (
                      <GitMerge aria-hidden="true" />
                    )}
                    {chosen === "mergePush" ? "Merge and push when checks pass" : "Merge when checks pass"}
                  </Button>
                )}
                {mergeCanBeOverridden(verdict) && verdict.kind === "failed" && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void confirm(chosen, undefined, checks.head)}
                  >
                    Merge anyway (checks failed: {verdict.check})
                  </Button>
                )}
              </>
            ) : (
              <Button
                size="sm"
                variant={behind === undefined && asks === undefined ? "primary" : "secondary"}
                disabled={busy}
                onClick={() => void confirm(chosen)}
              >
                {busy && <LoaderCircle aria-hidden="true" className="animate-spin" />}
                {busy ? "Working" : labels[chosen].confirm}
              </Button>
            )}
            {asks !== undefined && !busy && (
              <Button size="sm" variant="primary" onClick={() => void confirm(chosen, asks)}>
                {asks.extra && asks.create
                  ? "Send those commits, create the branch and ship"
                  : asks.extra
                    ? "Send those commits too and ship"
                    : "Create the branch and ship"}
              </Button>
            )}
            {behind !== undefined && !busy && (
              <Button size="sm" variant="primary" onClick={() => void updateAndShip(chosen)}>
                Update {behind.into} from {behind.remote} and ship
              </Button>
            )}
          </div>
        </div>
      )}
      {results !== undefined && (
        <div className="flex flex-col gap-2.5 border-t border-line pt-3">
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
            {results.map((r) => (
              <li
                key={r.project}
                className={cn(r.skipped ? "text-fg-faint" : r.ok ? "text-green" : "text-red", "text-pretty")}
              >
                {results.length > 1 && <span className="font-mono">{r.project}: </span>}
                {r.detail}
              </li>
            ))}
          </ul>
          {notPushed.length > 0 && (
            <p className="text-sm text-fg-muted text-pretty">
              Merged in your checkout, not pushed:{" "}
              <span className="font-mono">{notPushed.map((r) => `${r.project} (${r.into})`).join(", ")}</span>
              . Nothing was undone. Fix the cause, then push again.
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {notPushed.length > 0 && chosen === "mergePush" && (
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void confirm("mergePush")}>
                {busy && <LoaderCircle aria-hidden="true" className="animate-spin" />}
                Push again
              </Button>
            )}
            {conflicted.length > 0 &&
              lead !== undefined &&
              (chosen === "merge" || chosen === "mergePush") && (
                <ResolveButton
                  task={task}
                  lead={lead}
                  ship={{ action: chosen, into: intoText, method }}
                  target={target}
                  deleteAfter={deleteAfter}
                />
              )}
            <Button size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
    </section>,
    document.body,
  );
}

/**
 * A protected repo (infra): never shipped with the others. The owner ships it alone, into its
 * base, and must type its name first. The server refuses it without that name.
 */
function ProtectedRow({
  task,
  repo,
  method,
  disabled,
  onResults,
}: {
  task: Task;
  repo: { project: string; base: string; branch: string };
  method: MergeMethod;
  disabled: boolean;
  onResults: (results: ShipResult[]) => void;
}) {
  const after = useAfterTaskChange();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ready = typed.trim() === repo.project && !busy && !disabled;

  async function ship(push: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      const out = await cmd("tasks.merge", {
        id: task.id,
        project: repo.project,
        targets: { [repo.project]: repo.base },
        confirmProtected: typed.trim(),
        done: false,
        push,
        method,
        deleteAfter: false,
        pushLocalCommits: false,
        createRemoteBranch: false,
      });
      await after(out.task);
      setTyped("");
      onResults(out.results);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-amber-line bg-amber-wash px-2.5 py-2">
      <p className="flex items-start gap-1.5 text-sm text-fg text-pretty">
        <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-amber" />
        <span className="min-w-0">
          <span className="font-mono">{repo.project}</span> is protected. It never ships with the others. To
          ship <span className="font-mono">{repo.branch}</span> into{" "}
          <span className="font-mono">{repo.base}</span> alone, type its name.
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={`Type ${repo.project} to ship it`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={repo.project}
          spellCheck={false}
          autoComplete="off"
          className="h-8 min-w-0 flex-1 rounded-md border border-line-control bg-field px-2.5 font-mono text-sm text-fg placeholder:text-fg-faint"
        />
        <Button size="sm" variant="secondary" disabled={!ready} onClick={() => void ship(false)}>
          Merge
        </Button>
        <Button size="sm" variant="secondary" disabled={!ready} onClick={() => void ship(true)}>
          {busy && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          Merge and push
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red text-pretty">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * One click: majhi asks the lead to resolve the conflicts, run the checks and commit, then runs this
 * same ship by itself when the lead is done. A done task is opened again first.
 */
function ResolveButton({
  task,
  lead,
  ship,
  target,
  deleteAfter,
}: {
  task: Task;
  lead: string;
  ship: { action: "merge" | "mergePush"; into: string; method: MergeMethod };
  target: ShipTarget;
  deleteAfter: boolean;
}) {
  const after = useAfterTaskChange();
  const [state, setState] = useState<{ kind: "idle" | "sending" | "sent" } | { kind: "error"; text: string }>(
    { kind: "idle" },
  );
  const words = shipWords(ship);

  async function send() {
    setState({ kind: "sending" });
    try {
      const out = await cmd("tasks.resolveShip", {
        id: task.id,
        action: ship.action,
        method: ship.method,
        ...target,
        deleteAfter,
      });
      await after(out.task);
      setState({ kind: "sent" });
    } catch (err) {
      setState({ kind: "error", text: describeError(err) });
    }
  }

  if (state.kind === "sent") {
    return (
      <span className="mr-auto text-sm text-fg-muted text-pretty">
        Sent to <span className="font-mono">@{lead}</span>. majhi will {words} when it is done.
      </span>
    );
  }
  return (
    <>
      {state.kind === "error" && (
        <span role="alert" className="mr-auto text-sm text-red text-pretty">
          {state.text}
        </span>
      )}
      <Button
        size="sm"
        variant="primary"
        disabled={state.kind === "sending"}
        title={`Asks @${lead} to resolve the conflicts and commit, then majhi will ${words}`}
        onClick={() => void send()}
      >
        {state.kind === "sending" && <LoaderCircle aria-hidden="true" className="animate-spin" />}
        Resolve and {words}
      </Button>
    </>
  );
}

/** The ship majhi runs once the lead has resolved the conflicts, with Cancel. Nothing when none waits. */
export function PendingShipLine({ task }: { task: Task }) {
  const after = useAfterTaskChange();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = task.pendingShip;
  if (pending === undefined) return null;

  async function cancel() {
    setBusy(true);
    setError(undefined);
    try {
      const out = await cmd("tasks.cancelShip", { id: task.id });
      await after(out.task);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const words = shipWords(pending);
  return (
    <div className="flex flex-col gap-1">
      <p className="flex items-start gap-1.5 text-xs text-fg-muted text-pretty">
        <GitMerge aria-hidden="true" className="mt-px size-3.5 shrink-0 text-fg-faint" />
        <span className="min-w-0">
          Will {words} when <span className="font-mono">@{pending.lead}</span> resolves the conflicts.{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => void cancel()}
            className="cursor-pointer text-blue underline-offset-2 hover:underline disabled:cursor-default disabled:opacity-60"
          >
            Cancel
          </button>
        </span>
      </p>
      {error && (
        <p role="alert" className="text-xs text-red text-pretty">
          {error}
        </p>
      )}
    </div>
  );
}
