import type { ProcessContainer, ProcessInfo, Task } from "@majhi/shared";
import { useMutation } from "@tanstack/react-query";
import { ChevronRight, ExternalLink, Square } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { LAMP_TEXT, Lamp, type LampState } from "@/components/ui/lamp";
import { useToast } from "@/components/ui/toast";
import { type ApiRequestError, cmd } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useNow } from "@/lib/use-now";

/** More than this many processes fold into one summary line until the owner opens them. */
const FOLD_OVER = 3;

/** A process's lamp and its word: running, exit 0, stopped, or the failure. */
function processState(p: ProcessInfo): { lamp: LampState; word: string; failed: boolean } {
  if (p.status === "running") return { lamp: "working", word: "running", failed: false };
  if (p.status === "stopped") return { lamp: "idle", word: "stopped", failed: false };
  if (p.exitCode === 0) return { lamp: "done", word: "exit 0", failed: false };
  return {
    lamp: "paused",
    word: p.exitCode === null || p.exitCode === undefined ? "killed" : `exit ${p.exitCode}`,
    failed: true,
  };
}

/**
 * Background processes agents started through majhi (5.15): one line each. More than three fold to
 * a single summary line. Hidden when there are none.
 */
export function ProcessesCard({ task, processes }: { task: Task; processes: readonly ProcessInfo[] }) {
  const now = useNow(1_000);
  const [open, setOpen] = useState(false);
  if (processes.length === 0) return null;
  // Running first, then the most recent ends.
  const shown = [...processes].sort((a, b) => {
    if ((a.status === "running") !== (b.status === "running")) return a.status === "running" ? -1 : 1;
    return (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt);
  });
  const running = processes.filter((p) => p.status === "running").length;
  const failed = processes.filter((p) => processState(p).failed).length;
  const folds = processes.length > FOLD_OVER;
  const expanded = !folds || open;
  const summary = (
    <>
      <h2 id="processes-heading" className="text-sm font-semibold">
        Processes
      </h2>
      <span className="tnum flex min-w-0 flex-1 items-center gap-1.5 truncate text-xs text-fg-faint">
        <span className="font-mono text-fg-muted">{processes.length}</span>
        {running > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <Lamp state="working" size={6} />
            <span className={LAMP_TEXT.working}>{running} running</span>
          </>
        )}
        {failed > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span className="text-red">{failed} failed</span>
          </>
        )}
      </span>
    </>
  );
  return (
    <Card aria-labelledby="processes-heading" className="shrink-0 gap-0 px-3 py-2">
      {folds ? (
        <button
          type="button"
          aria-expanded={expanded}
          title={expanded ? "Fold the processes" : "Show every process"}
          onClick={() => setOpen((v) => !v)}
          className="-mx-1 flex h-6 cursor-pointer items-center gap-2 rounded-sm px-1 text-left hover:bg-raised"
        >
          {summary}
          <ChevronRight
            aria-hidden="true"
            className={cn("size-3.5 shrink-0 text-fg-faint transition-transform", expanded && "rotate-90")}
          />
        </button>
      ) : (
        <div className="flex h-6 items-center gap-2">{summary}</div>
      )}
      {expanded && (
        <ul
          aria-label="Processes"
          className="m-0 mt-0.5 flex max-h-[min(240px,32dvh)] list-none flex-col overflow-y-auto overscroll-contain p-0 scroll-fade"
        >
          {shown.map((p) => (
            <ProcessRow key={p.id} task={task.id} process={p} now={now} />
          ))}
        </ul>
      )}
    </Card>
  );
}

/** One line: lamp, name, state or run time, the port, Stop. Clicking the name shows details and output. */
function ProcessRow({ task, process: p, now }: { task: string; process: ProcessInfo; now: number }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const stop = useMutation<{ process: ProcessInfo }, ApiRequestError, void>({
    mutationFn: () => cmd("processes.stop", { task, id: p.id }),
    onError: (error) => toast("Could not stop", { detail: error.message, tone: "error" }),
  });
  const running = p.status === "running";
  const state = processState(p);
  const took = elapsed(p.startedAt, running ? now : Date.parse(p.endedAt ?? p.startedAt));
  const link = p.container?.hostUrl ?? (p.port === undefined ? undefined : `http://localhost:${p.port}`);
  return (
    <li className="flex flex-col">
      <div className="flex h-7 min-w-0 items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          title={open ? "Hide output" : `Show output of ${p.name}`}
          onClick={() => setOpen((v) => !v)}
          className="-ml-1 flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm px-1 text-left hover:bg-raised"
        >
          <Lamp state={state.lamp} size={7} />
          <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
          <span
            className={cn(
              "tnum shrink-0 font-mono text-xs",
              state.failed ? "text-red" : running ? "text-fg-muted" : "text-fg-faint",
            )}
          >
            {running ? took : state.word}
          </span>
        </button>
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            title={p.container?.hostUrl ? "Open preview" : `Open localhost:${p.port}`}
            className="flex h-6 shrink-0 items-center gap-0.5 rounded-sm px-1 font-mono text-xs text-blue hover:bg-raised hover:underline"
          >
            {p.port === undefined ? "preview" : `:${p.port}`}
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
        )}
        {running && (
          <button
            type="button"
            disabled={stop.isPending}
            onClick={() => stop.mutate()}
            aria-label={`Stop ${p.name}`}
            title={`Stop ${p.name}`}
            className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-45"
          >
            <Square aria-hidden="true" className="size-2.5" fill="currentColor" />
          </button>
        )}
      </div>
      {open && (
        <div className="flex flex-col gap-1 pb-2 pl-4">
          {p.container ? (
            <ContainerLine container={p.container} />
          ) : (
            p.name !== p.command && (
              <span className="truncate font-mono text-xs text-fg-muted" title={p.command}>
                {p.command}
              </span>
            )
          )}
          <span className="text-xs text-fg-faint">
            {p.id} · @{p.agent} · {running ? "running" : "ran"} {took}
            {!p.wait && running && " · keeps running"}
          </span>
          {p.tail.length > 0 && (
            <pre className="max-h-48 overflow-auto rounded-sm bg-sunken px-2 py-1 font-mono text-[11px] leading-[1.45] text-fg-muted">
              {p.tail.join("\n")}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

/** What a container process is: its kind and image, and where runners reach it. */
function ContainerLine({ container: c }: { container: ProcessContainer }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-muted">
      <Badge tone={c.kind === "preview" ? "blue" : "neutral"}>{c.kind}</Badge>
      <span className="truncate font-mono" title={c.image}>
        {c.image}
      </span>
      {c.url && (
        <span className="font-mono" title="Where this task's runners reach it">
          {c.url}
        </span>
      )}
    </span>
  );
}

/** `12s`, `4m 3s`, `1h 20m`. */
function elapsed(from: string, to: number): string {
  const s = Math.max(0, Math.round((to - Date.parse(from)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
