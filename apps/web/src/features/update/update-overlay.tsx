import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { CommandLine } from "@/components/command-line";
import { Button } from "@/components/ui/button";
import { cmd, getHealth } from "@/lib/api";
import { cn } from "@/lib/cn";
import { type UpdatePhase, updatePhase } from "./model";
import { endUpdateSession, useUpdateSession } from "./session";

const POLL_MS = 1_000;
const PROBE_TIMEOUT_MS = 1_500;
/** A build can be slow, but an update that takes longer than this has stopped. */
export const UPDATE_TIMEOUT_MS = 20 * 60_000;

/**
 * "Updating majhi": covers the whole window while the helper rebuilds and restarts the server, shows
 * the helper's progress lines, and reloads the page once `/health` answers with the new commit.
 * It is mounted above the app gate, so it stays while the server is down.
 */
export function UpdateOverlay() {
  const session = useUpdateSession();
  if (!session) return null;
  return <Running startedAt={session.startedAt} />;
}

function Running({ startedAt }: { startedAt: string }) {
  const [phase, setPhase] = useState<UpdatePhase>({ kind: "building", lines: [] });
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const stop = new AbortController();
    const deadline = Date.now() + UPDATE_TIMEOUT_MS;
    let timer: number | undefined;
    async function poll() {
      if (stop.signal.aborted) return;
      if (Date.now() > deadline) {
        setTimedOut(true);
        return;
      }
      const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
      const health = await getHealth(signal).catch(() => undefined);
      const version = health ? await cmd("system.version", {}).catch(() => undefined) : undefined;
      if (stop.signal.aborted) return;
      const next = updatePhase({
        status: version?.update,
        serverUp: health !== undefined,
        healthCommit: health?.commit,
        startedAt,
      });
      if (next.kind === "back") {
        endUpdateSession();
        window.location.reload();
        return;
      }
      setPhase((prev) =>
        next.kind !== "restarting" || next.lines.length > 0 ? next : withLines(next, prev),
      );
      timer = window.setTimeout(poll, POLL_MS);
    }
    void poll();
    return () => {
      stop.abort();
      window.clearTimeout(timer);
    };
  }, [startedAt]);

  const failed = phase.kind === "failed" || timedOut;
  const lines = "lines" in phase ? phase.lines : [];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/85 p-6 backdrop-blur-sm">
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="update-title"
        aria-busy={!failed}
        className={cn(
          "flex w-full max-w-[600px] flex-col rounded-xl border bg-raised",
          failed ? "border-red-line" : "border-line-strong",
        )}
      >
        <div className="flex flex-col gap-2 p-5 pb-4">
          <h1 id="update-title" className="text-lg font-semibold text-balance">
            {failed ? "The update did not finish" : "Updating majhi"}
          </h1>
          <p className="text-base text-fg-muted text-pretty">
            {failed
              ? phase.kind === "failed"
                ? phase.error
                : "majhi has not come back after 20 minutes."
              : "majhi is rebuilding and goes offline for a few seconds. This page carries on by itself and reloads when the new version answers."}
          </p>
        </div>
        <ol
          aria-label="Update progress"
          className="mx-5 mb-5 flex max-h-72 flex-col overflow-y-auto rounded-md border border-line-strong"
        >
          {lines.length === 0 && (
            <li className="flex h-9 items-center gap-2.5 px-3 text-base text-fg-muted">
              <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin text-accent-text" />
              Waiting for the host helper
            </li>
          )}
          {lines.map((line, i) => {
            const last = i === lines.length - 1;
            const spinning = last && !failed;
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: progress lines only ever grow, and the same line can repeat
                key={`${i}-${line}`}
                className="flex min-h-9 items-center gap-2.5 border-line-strong px-3 py-1.5 text-base not-last:border-b"
              >
                {spinning ? (
                  <LoaderCircle
                    aria-hidden="true"
                    className="size-3.5 shrink-0 animate-spin text-accent-text"
                  />
                ) : last && failed ? (
                  <CircleAlert aria-hidden="true" className="size-3.5 shrink-0 text-red" />
                ) : (
                  <Check aria-hidden="true" className="size-3.5 shrink-0 text-green" />
                )}
                <span className={cn("min-w-0 text-pretty", spinning ? "text-fg" : "text-fg-muted")}>
                  {line}
                </span>
              </li>
            );
          })}
        </ol>
        {phase.kind === "restarting" && !failed && (
          <p className="px-5 pb-5 text-sm text-fg-faint">Starting the new version.</p>
        )}
        {failed && (
          <div className="flex flex-col gap-3 border-t border-line px-5 py-4">
            <p className="text-base text-fg-muted">
              The old majhi keeps running when a build fails. To try again by hand, run this in the majhi
              folder:
            </p>
            <CommandLine command="make up" />
            <div className="ml-auto">
              <Button variant="primary" onClick={endUpdateSession}>
                Close
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/** The restart step has no lines of its own before the new server answers, so keep the last ones. */
function withLines(next: UpdatePhase, prev: UpdatePhase): UpdatePhase {
  return "lines" in prev && next.kind === "restarting" ? { kind: "restarting", lines: prev.lines } : next;
}
