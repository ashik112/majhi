import type { E2eRun } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { Dot, type DotTone, toneText } from "@/components/ui/status-dot";
import { cn } from "@/lib/cn";
import { useE2eStatus } from "@/lib/e2e-queries";
import { formatAgo } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { useNow } from "@/lib/use-now";

/** "4m 12s", "1h 5m". */
function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const WORD: Record<E2eRun["status"], { text: string; tone: DotTone }> = {
  passed: { text: "passed", tone: "green" },
  failed: { text: "failed", tone: "red" },
  errored: { text: "could not run", tone: "amber" },
  running: { text: "running", tone: "working" },
  queued: { text: "queued", tone: "idle" },
  replaced: { text: "replaced", tone: "idle" },
};

/** One run: lamp, commit, result, duration, when. Hub setup leaves the project name out. */
export function RunLine({ run, now, hideProject }: { run: E2eRun; now: number; hideProject?: boolean }) {
  const word = WORD[run.status];
  const when = run.finishedAt ?? run.startedAt ?? run.queuedAt;
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
      <Dot tone={word.tone} />
      {!hideProject && <span className="font-medium">{run.project}</span>}
      <span className="font-mono text-xs text-fg-muted" title={run.subject}>
        {run.commit.slice(0, 7)}
      </span>
      <span className={cn(toneText(word.tone))}>
        {word.text}
        {run.status === "failed" && run.failed !== undefined && `, ${run.failed} failing`}
      </span>
      {run.durationMs !== undefined && <span className="text-fg-muted">{duration(run.durationMs)}</span>}
      <span className="text-fg-faint">{formatAgo(when, now)}</span>
      {run.status === "errored" && run.error && <span className="truncate text-fg-faint">{run.error}</span>}
      {run.status === "failed" && run.breakTask && (
        <Link
          to="/t/$taskId"
          params={{ taskId: run.breakTask }}
          className="font-mono text-xs underline-offset-2 hover:underline"
        >
          {run.breakTask}
        </Link>
      )}
    </li>
  );
}

/**
 * The background e2e suite on main: the newest result per project (commit, passed or failed, duration,
 * when), the run in progress and what waits. Nothing shows for a project the suite is off for.
 */
export function E2ePanel() {
  const status = useE2eStatus();
  const now = useNow(30_000);
  const data = status.data;
  if (data === undefined) return null;
  const on = new Set(data.projects.filter((p) => p.mode !== "off").map((p) => p.id));
  const latest = data.latest.filter((r) => on.has(r.project));
  if (on.size === 0 && data.running === undefined) return null;
  const pending = data.queued.length;
  return (
    <section aria-label="Background e2e on main" className={cn("flex shrink-0 flex-col rounded-2xl", GLASS)}>
      <div className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
        <h2 className="text-base font-semibold">Background e2e</h2>
        <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-1">
          {data.running && <RunLine run={data.running} now={now} />}
          {latest.map((run) => (
            <RunLine key={run.id} run={run} now={now} />
          ))}
          {latest.length === 0 && !data.running && <li className="text-sm text-fg-faint">No run yet.</li>}
        </ul>
        {pending > 0 && <span className="text-sm text-fg-faint">{pending} waiting</span>}
      </div>
    </section>
  );
}
