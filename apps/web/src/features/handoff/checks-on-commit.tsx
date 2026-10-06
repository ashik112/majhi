import type { HandoffStepId } from "@majhi/shared";
import { Fragment } from "react";
import { cn } from "@/lib/cn";

/** What the hand-off check looks at, in the order the owner reads it. */
const PARTS: readonly { step: HandoffStepId; label: string }[] = [
  { step: "ready", label: "merges cleanly" },
  { step: "tests", label: "tests" },
  { step: "build", label: "build" },
  { step: "lint", label: "lint" },
];

/**
 * The checks in plain words: "Checks on this commit: merges cleanly, tests, build, lint", with the
 * step that runs now highlighted. `after` is a short tail, like "2 min".
 */
export function ChecksOnCommit({ step, after }: { step?: HandoffStepId | undefined; after?: string }) {
  return (
    <span>
      Checks on this commit:{" "}
      {PARTS.map((p, i) => (
        <Fragment key={p.step}>
          {i > 0 && ", "}
          <span
            {...(step === p.step ? { "aria-current": "step" as const } : {})}
            className={cn(step === p.step && "rounded-sm bg-accent-wash px-1 font-medium text-fg")}
          >
            {p.label}
          </span>
        </Fragment>
      ))}
      {after !== undefined && after !== "" && ` · ${after}`}
    </span>
  );
}
