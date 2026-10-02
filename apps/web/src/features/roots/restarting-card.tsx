import { collapseHome, RESTART_COMMAND } from "@majhi/shared";
import { Check, Circle, LoaderCircle, RotateCw } from "lucide-react";
import * as m from "motion/react-m";
import type { ReactNode } from "react";
import { CommandLine } from "@/components/command-line";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { plural } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { RESTART_TIMEOUT_MS, type RestartPhase, useRestartWatch } from "./use-restart-watch";

const STEPS = ["stopping", "starting", "scanning"] as const satisfies readonly RestartPhase[];

/**
 * Shown while the host helper remounts roots (SPEC 3.5): majhi goes down and comes back, and this
 * card follows it through `/health`. When it is back the config and repos are fresh and `onBack`
 * runs. After 90 s it falls back to the manual restart command.
 */
export function RestartingCard({
  roots,
  home,
  continueLabel,
  onBack,
  onContinue,
}: {
  /** Absolute paths of the roots being mounted. */
  roots: readonly string[];
  home: string;
  continueLabel: string;
  onBack: () => void;
  /** The way out after a time-out, for example "Show repos now". */
  onContinue: () => void;
}) {
  const { phase, startedAt, checkAgain } = useRestartWatch(onBack);
  const now = useNow(1000);
  const names = roots.map((path) => collapseHome(path, home));
  const label =
    names.length === 0
      ? "new folders"
      : names.length <= 2
        ? names.join(" and ")
        : plural(names.length, "folder");

  if (phase === "timed-out") {
    return (
      <Card tone="amber" titleId="restart-title">
        <div className="flex flex-col gap-2 p-5 pb-4">
          <h1 id="restart-title" className="text-lg font-semibold text-balance">
            majhi did not come back
          </h1>
          <p className="text-base text-fg-muted text-pretty">
            The host helper was mounting {label}, but majhi has not answered for{" "}
            {Math.round(RESTART_TIMEOUT_MS / 1000)} seconds. Run this in the majhi folder on your machine,
            then check again.
          </p>
        </div>
        <div className="px-5">
          <CommandLine command={RESTART_COMMAND} />
        </div>
        <div className="mt-5 flex items-center gap-2 border-t border-line px-5 py-3">
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" onClick={onContinue}>
              {continueLabel}
            </Button>
            <Button variant="primary" onClick={checkAgain}>
              <RotateCw aria-hidden="true" />
              Check again
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  const current = STEPS.indexOf(phase);
  const elapsed = Math.max(0, Math.round((now - startedAt) / 1000));
  const stepLabels: Record<(typeof STEPS)[number], string> = {
    stopping: "Stopping majhi",
    starting: `Starting with ${label} mounted`,
    scanning: "Scanning for repos",
  };

  return (
    <Card tone="neutral" titleId="restart-title" busy>
      <div className="flex flex-col gap-2 p-5 pb-4">
        <h1 id="restart-title" className="text-lg font-semibold text-balance">
          Restarting majhi to mount {label}
        </h1>
        <p className="text-base text-fg-muted text-pretty">
          majhi goes offline for a few seconds while the host helper mounts{" "}
          {names.length === 1 ? "it" : "them"}. This page carries on by itself.
        </p>
      </div>
      <ol
        aria-label="Restart progress"
        className="mx-5 mb-5 flex flex-col rounded-md border border-line-strong"
      >
        {STEPS.map((step, index) => {
          const state = index < current ? "done" : index === current ? "active" : "waiting";
          return (
            <li
              key={step}
              aria-current={state === "active" ? "step" : undefined}
              className="flex h-9 items-center gap-2.5 border-line-strong px-3 not-last:border-b"
            >
              {state === "done" && <Check aria-hidden="true" className="size-3.5 shrink-0 text-green" />}
              {state === "active" && (
                <LoaderCircle
                  aria-hidden="true"
                  className="size-3.5 shrink-0 animate-spin text-accent-text"
                />
              )}
              {state === "waiting" && (
                <Circle aria-hidden="true" className="size-3.5 shrink-0 text-line-hover" />
              )}
              <span
                className={cn(
                  "min-w-0 truncate text-base",
                  state === "waiting" ? "text-fg-faint" : state === "active" ? "text-fg" : "text-fg-muted",
                )}
              >
                {stepLabels[step]}
              </span>
              {state === "active" && (
                <span className="ml-auto shrink-0 font-mono text-sm text-fg-faint tabular-nums">
                  {elapsed} s
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p aria-live="polite" className="sr-only">
        {stepLabels[STEPS[current] ?? "stopping"]}
      </p>
    </Card>
  );
}

function Card({
  tone,
  titleId,
  busy,
  children,
}: {
  tone: "neutral" | "amber";
  titleId: string;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <m.section
      aria-labelledby={titleId}
      aria-busy={busy}
      initial={{ opacity: 0, y: 10, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "flex h-fit w-full max-w-[600px] flex-col rounded-xl border bg-card",
        tone === "amber" ? "border-amber-line" : "border-line-strong",
      )}
    >
      {children}
    </m.section>
  );
}
