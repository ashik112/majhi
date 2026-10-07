import {
  DEPLOY_STATE_WORD,
  type HandoffStepId,
  SHIP_STEP_LABEL,
  type TrailKind,
  type TrailStep,
  type TrailTone,
} from "@majhi/shared";
import type { LampState } from "@/components/ui/lamp";

/**
 * How a trail step reads on a screen: its label, the word for its state, and whether it is the one
 * the owner is waiting on. Pure, so the task page, the board card and the tree row say the same.
 */
export interface StepView {
  key: string;
  kind: TrailKind;
  label: string;
  /** The state in a word or two. Shown for a waiting step, and in the title of every step. */
  word: string;
  tone: TrailTone;
  /** Needs the owner, or is held: its label and word are never dropped to make room. */
  waiting: boolean;
  step: TrailStep;
}

export const TONE_LAMP: Record<TrailTone, LampState> = {
  done: "done",
  working: "working",
  needs: "needs",
  paused: "paused",
  idle: "idle",
};

/** A failed hand-off step in words. */
const FAILED_STEP: Record<HandoffStepId, string> = {
  ready: "not ready",
  install: "install failed",
  tests: "tests failed",
  build: "build failed",
  lint: "lint failed",
  acceptance: "acceptance failed",
  review: "review failed",
};

const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const REPLY_WORD = {
  done: "sent",
  working: "sending",
  needs: "waits for you",
  paused: "held",
  idle: "when live",
} as const;

function stepView(step: TrailStep, index: number): StepView {
  const base = { key: `${step.kind}:${index}`, kind: step.kind, tone: step.tone, step };
  const waiting = step.tone === "needs" || step.tone === "paused";
  switch (step.kind) {
    case "children":
      return {
        ...base,
        label: `Subtasks ${step.total}`,
        word: step.tone === "done" ? "done" : `${step.done} of ${step.total} done`,
        waiting,
      };
    case "check":
      return {
        ...base,
        label: "Checks",
        word:
          step.result === "green"
            ? "passed"
            : step.result === "red"
              ? FAILED_STEP[step.failedStep ?? "tests"]
              : step.result,
        waiting,
      };
    case "merge-request": {
      const [first, ...rest] = step.mrs;
      const closed = step.mrs.some((m) => m.state === "closed");
      const failing = step.mrs.some((m) => m.ci === "failing");
      return {
        ...base,
        label: `MR !${first?.number ?? ""}${rest.length > 0 ? ` +${rest.length}` : ""}`,
        word:
          step.tone === "done"
            ? "merged"
            : step.tone === "working"
              ? "checks running"
              : closed
                ? "closed"
                : failing
                  ? "CI failed"
                  : "ready to merge",
        waiting,
      };
    }
    case "local-merge":
      return {
        ...base,
        label: "Merge",
        word: step.stage === "merged" ? "merged" : "waits for the lead",
        waiting,
      };
    case "ship":
      return { ...base, label: SHIP_STEP_LABEL[step.step], word: "waits for you", waiting };
    case "deploy":
      return { ...base, label: capital(step.env), word: DEPLOY_STATE_WORD[step.state], waiting };
    case "reply":
      return { ...base, label: "Reply", word: REPLY_WORD[step.tone], waiting };
  }
}

export function stepViews(steps: readonly TrailStep[]): StepView[] {
  return steps.map(stepView);
}

/** "Subtasks 2, done". The title of a step, and what a screen reader says. */
export const stepTitle = (view: StepView): string => `${view.label}, ${view.word}`;

/**
 * How the strip on the tabs row fits the room it has. `full`: every label. `short`: finished steps
 * show only their icon and check, which frees the most room for the least loss. `line`: even that is
 * too wide, so the strip takes its own line under the tabs, with every label. The numbers are widths
 * the screen measured, so the choice is never a guess.
 */
export type StripFit = "full" | "short" | "line";

export function fitFor(room: { available: number; full: number; doneLabels: number }): StripFit {
  // Half a pixel of slack: widths are fractions.
  if (room.full <= room.available + 0.5) return "full";
  if (room.full - room.doneLabels <= room.available + 0.5) return "short";
  return "line";
}
