import type { ProcessContainer, ProcessInfo, Task } from "@majhi/shared";
import { useMutation } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { type ApiRequestError, cmd } from "@/lib/api";
import { useNow } from "@/lib/use-now";

/** Output lines a collapsed row shows. */
const SHORT_TAIL = 3;

/** Background processes agents started through majhi (5.15). Hidden when there are none. */
export function ProcessesCard({ task, processes }: { task: Task; processes: readonly ProcessInfo[] }) {
  const now = useNow(1_000);
  if (processes.length === 0) return null;
  // Running first, then the most recent ends.
  const shown = [...processes].sort((a, b) => {
    if ((a.status === "running") !== (b.status === "running")) return a.status === "running" ? -1 : 1;
    return (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt);
  });
  return (
    <Card aria-labelledby="processes-heading" className="gap-0 px-3 py-2.5">
      <h2 id="processes-heading" className="pb-1 text-sm font-semibold">
        Processes
      </h2>
      <ul className="flex flex-col divide-y divide-line">
        {shown.map((p) => (
          <ProcessRow key={p.id} task={task.id} process={p} now={now} />
        ))}
      </ul>
    </Card>
  );
}

function ProcessRow({ task, process: p, now }: { task: string; process: ProcessInfo; now: number }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const stop = useMutation<{ process: ProcessInfo }, ApiRequestError, void>({
    mutationFn: () => cmd("processes.stop", { task, id: p.id }),
    onError: (error) => toast("Could not stop", { detail: error.message, tone: "error" }),
  });
  const running = p.status === "running";
  const took = elapsed(p.startedAt, running ? now : Date.parse(p.endedAt ?? p.startedAt));
  const lines = open ? p.tail : p.tail.slice(-SHORT_TAIL);
  return (
    <li className="flex flex-col gap-1 py-2 first:pt-1 last:pb-0">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm" title={p.name}>
          {p.name}
        </span>
        {running ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={stop.isPending}
            onClick={() => stop.mutate()}
            aria-label={`Stop ${p.name}`}
          >
            Stop
          </Button>
        ) : (
          <EndChip process={p} />
        )}
      </div>
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
        {p.port !== undefined && (
          <>
            {" · "}
            <a
              className="text-blue hover:underline"
              href={`http://localhost:${p.port}`}
              target="_blank"
              rel="noreferrer"
            >
              port {p.port}
            </a>
          </>
        )}
        {!p.wait && running && " · keeps running"}
      </span>
      {lines.length > 0 && (
        <pre
          className={`overflow-x-auto rounded-sm bg-raised px-2 py-1 font-mono text-[11px] leading-[1.45] text-fg-muted ${open ? "max-h-64 overflow-y-auto" : ""}`}
        >
          {lines.join("\n")}
        </pre>
      )}
      {p.tail.length > SHORT_TAIL && (
        <button
          type="button"
          className="self-start text-xs text-fg-faint hover:text-fg"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Show less" : `Show ${p.tail.length} lines`}
        </button>
      )}
    </li>
  );
}

/** What a container process is: its kind and image, where runners reach it, and the preview's link. */
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
      {c.hostUrl && (
        <a
          className="inline-flex items-center gap-1 text-blue hover:underline"
          href={c.hostUrl}
          target="_blank"
          rel="noreferrer"
        >
          Open preview
          <ExternalLink aria-hidden="true" className="size-3" />
        </a>
      )}
    </span>
  );
}

function EndChip({ process: p }: { process: ProcessInfo }) {
  if (p.status === "stopped") return <Badge>Stopped</Badge>;
  if (p.exitCode === 0)
    return (
      <Badge tone="green" mono>
        exit 0
      </Badge>
    );
  return (
    <Badge tone="red" mono>
      {p.exitCode === null || p.exitCode === undefined ? "killed" : `exit ${p.exitCode}`}
    </Badge>
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
