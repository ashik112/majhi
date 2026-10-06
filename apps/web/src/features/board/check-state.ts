import type { HandoffStepId, HomeBackground, HomeCheck } from "@majhi/shared";
import { mergeCanBeOverridden } from "@majhi/shared";

/**
 * What a review row says about its checks, from the merge gate's verdict and the hand-off's state
 * (`tasks.homeFacts`). Pure: no text is read, so the line and the button follow from typed data.
 */

export type CheckKind = "ok" | "failed" | "timeout" | "flaky" | "secret" | "stale" | "running" | "queued";

/** What the row's primary button does. `wait`: nothing to press, a spinner and the time instead. */
export type CheckButton = "merge" | "see-failure" | "check-again" | "wait";

export interface CheckState {
  kind: CheckKind;
  button: CheckButton;
  label: string;
  /** "Merge anyway" may be offered next to the primary one: only a failed check the owner may judge. */
  mergeAnyway: boolean;
}

const LABEL: Record<CheckButton, string> = {
  merge: "Merge",
  "see-failure": "See failure",
  "check-again": "Check again",
  wait: "Checking",
};

function state(kind: CheckKind, button: CheckButton, mergeAnyway = false): CheckState {
  return { kind, button, label: LABEL[button], mergeAnyway };
}

/** The state of a review task's checks. A check that runs or waits comes before any older verdict. */
export function checkState(fact: HomeCheck): CheckState {
  const activity = fact.activity;
  if (activity?.phase === "queued") return { ...state("queued", "wait"), label: "Queued" };
  if (activity?.phase === "running") return state("running", "wait");
  const verdict = fact.checks.verdict;
  switch (verdict.kind) {
    case "ok":
      return state("ok", "merge");
    case "running":
      return state("running", "wait");
    case "stale":
      return state("stale", "check-again");
    case "blocked":
      return state("failed", "see-failure");
    case "failed": {
      if (verdict.check === "secret") return state("secret", "see-failure");
      const status = fact.failedStep?.status;
      if (status === "timeout") return state("timeout", "check-again", mergeCanBeOverridden(verdict));
      if (status === "flaky") return state("flaky", "see-failure", mergeCanBeOverridden(verdict));
      return state("failed", "see-failure", mergeCanBeOverridden(verdict));
    }
  }
}

/** "45s", "4m", "1h 5m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

/** "1st", "2nd", "3rd", "4th". */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

const STEP_WORD: Record<HandoffStepId, string> = {
  ready: "starting",
  install: "install",
  tests: "tests",
  build: "build",
  lint: "lint",
  acceptance: "brief",
  review: "review",
};

const CHECK_WORD = { test: "Tests", build: "Build", lint: "Lint", secret: "Secret scan" } as const;

/** The one line a review row's detail column shows for its checks. */
export function checkLine(fact: HomeCheck, now: number): string {
  const s = checkState(fact);
  const a = fact.activity;
  const since = a === undefined ? undefined : Date.parse(a.since);
  const verdict = fact.checks.verdict;
  switch (s.kind) {
    case "queued":
      return a?.position === undefined ? "Queued for checks" : `Queued for checks (${ordinal(a.position)})`;
    case "running": {
      const word = a?.step === undefined ? "checks" : STEP_WORD[a.step];
      return since === undefined || Number.isNaN(since)
        ? `Checking: ${word}`
        : `Checking: ${word} ${duration(now - since)}`;
    }
    case "stale":
      return "Checks not run on the latest commit";
    case "ok":
      return verdict.kind === "ok" && verdict.noChecks === true
        ? "Ready to merge, no checks set up"
        : "Ready to merge";
    case "secret":
      return "The diff holds what looks like a secret";
    case "timeout":
    case "flaky":
    case "failed": {
      const word = verdict.kind === "failed" ? CHECK_WORD[verdict.check] : "Checks";
      const ms = fact.failedStep?.ms;
      if (s.kind === "timeout")
        return ms === undefined ? `${word} timed out` : `${word} timed out at ${duration(ms)}`;
      if (s.kind === "flaky") return `${word} flaky: failed, then passed on a retry`;
      return ms === undefined ? `${word} failed` : `${word} failed after ${duration(ms)}`;
    }
  }
}

/** The elapsed time the primary spot shows while a check runs. */
export function checkElapsed(fact: HomeCheck, now: number): string {
  const since = fact.activity === undefined ? Number.NaN : Date.parse(fact.activity.since);
  return Number.isNaN(since) ? "" : duration(now - since);
}

/** The line of a background row: what runs. */
export function backgroundLine(item: HomeBackground): string {
  switch (item.kind) {
    case "check":
      return `Checking: ${item.label in STEP_WORD ? STEP_WORD[item.label as HandoffStepId] : item.label}`;
    case "queued-check":
      return item.position === undefined
        ? "Queued for checks"
        : `Queued for checks (${ordinal(item.position)})`;
    case "process":
      return `Process: ${item.label}`;
    case "build":
      return `Preview build: ${item.label}`;
    case "preview":
      return `Preview: ${item.label}`;
    case "service":
      return `Service: ${item.label}`;
  }
}

const BACKGROUND_CHIP: Record<HomeBackground["kind"], string> = {
  check: "Checking",
  "queued-check": "Queued",
  process: "Process",
  build: "Building",
  preview: "Preview",
  service: "Service",
};

export const backgroundChip = (kind: HomeBackground["kind"]): string => BACKGROUND_CHIP[kind];
