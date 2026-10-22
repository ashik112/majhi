import type { ProcessInfo } from "@majhi/shared";
import { useMutation } from "@tanstack/react-query";
import { ChevronRight, ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LAMP_TEXT, Lamp, type LampState } from "@/components/ui/lamp";
import { useToast } from "@/components/ui/toast";
import { type ApiRequestError, cmd } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useNow } from "@/lib/use-now";
import { oneLine } from "./model";

/** A run's lamp and its word: running, exit 0, stopped, or the failure. */
function stateOf(p: ProcessInfo): { lamp: LampState; word: string; failed: boolean } {
  if (p.status === "running") return { lamp: "working", word: "running", failed: false };
  if (p.status === "stopped") return { lamp: "idle", word: "stopped", failed: false };
  if (p.exitCode === 0) return { lamp: "done", word: "exit 0", failed: false };
  return {
    lamp: "paused",
    word: p.exitCode === null || p.exitCode === undefined ? "killed" : `exit ${p.exitCode}`,
    failed: true,
  };
}

/** `12s`, `4m 3s`, `1h 20m`. */
function elapsed(from: string, to: number): string {
  const s = Math.max(0, Math.round((to - Date.parse(from)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Where it runs: the container it lives in, the name its network answers to, or the folder it started in. */
function whereOf(p: ProcessInfo, folder: string): string {
  if (p.container !== undefined) return `in ${p.container.kind} ${p.container.name}`;
  if (p.host !== undefined) return `on ${p.host}`;
  const base = folder.endsWith("/") ? folder : `${folder}/`;
  return p.cwd === folder || p.cwd === base.slice(0, -1)
    ? "in the task folder"
    : `in ${p.cwd.replace(base, "")}`;
}

/**
 * A background process, where it started, as one line: its lamp, "Process", the command, where it runs, how long
 * it has run or how it ended, its output, Open when it serves a port, and Stop while it runs. It updates in place.
 */
export function ProcessLine({
  item,
  live,
  folder,
}: {
  item: { task: string; process: ProcessInfo };
  /** The process list's newest report of the same run: its output moves while it runs. */
  live: ProcessInfo | undefined;
  folder: string;
}) {
  const p = live !== undefined && live.startedAt === item.process.startedAt ? live : item.process;
  const toast = useToast();
  const now = useNow(1000);
  const [open, setOpen] = useState(false);
  const stop = useMutation<{ process: ProcessInfo }, ApiRequestError, void>({
    mutationFn: () => cmd("processes.stop", { task: item.task, id: p.id }),
    onError: (error) => toast("Could not stop", { detail: error.message, tone: "error" }),
  });
  const running = p.status === "running";
  const state = stateOf(p);
  const took = elapsed(p.startedAt, running ? now : Date.parse(p.endedAt ?? p.startedAt));
  const link = p.container?.hostUrl ?? (p.port === undefined ? undefined : `http://localhost:${p.port}`);
  return (
    <div className="ml-[34px] flex min-w-0 flex-col rounded-lg border border-line-strong bg-card px-3 py-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
        <Lamp state={state.lamp} size={8} />
        <span className="font-semibold text-fg">Process</span>
        <code
          title={p.command}
          className="min-w-0 max-w-full truncate rounded-[4px] bg-field px-1.5 py-px font-mono text-xs text-fg"
        >
          {oneLine(p.command, 70)}
        </code>
        <span className="text-fg-muted">{whereOf(p, folder)}</span>
        <span
          className={cn(
            "tnum text-fg-muted",
            state.failed && "text-red",
            running && LAMP_TEXT.working,
            !running && !state.failed && "text-fg-faint",
          )}
        >
          {running ? `running ${took}` : `${state.word} after ${took}`}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex cursor-pointer items-center gap-0.5 rounded-sm px-1 text-fg-muted hover:text-fg"
          >
            Output
            <ChevronRight
              aria-hidden="true"
              className={cn("size-3 transition-transform", open && "rotate-90")}
            />
          </button>
          {link !== undefined && (
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              title={p.container?.hostUrl ? "Open preview" : `Open localhost:${p.port}`}
              className="flex items-center gap-0.5 rounded-sm px-1 text-blue hover:underline"
            >
              Open
              <ExternalLink aria-hidden="true" className="size-3" />
            </a>
          )}
          {running && (
            <Button size="sm" className="h-6 px-2" disabled={stop.isPending} onClick={() => stop.mutate()}>
              Stop
            </Button>
          )}
        </span>
      </div>
      {open && (
        <pre className="m-0 mt-1.5 max-h-48 overflow-auto rounded-sm bg-sunken px-2 py-1 font-mono text-[11px] leading-[1.45] whitespace-pre-wrap break-words text-fg-muted">
          {p.tail.length === 0 ? "It printed nothing yet." : p.tail.join("\n")}
        </pre>
      )}
    </div>
  );
}
