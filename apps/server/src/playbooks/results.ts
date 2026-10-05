import type { CaptainChore, PlaybookRun } from "@majhi/shared";

/** The last result of a playbook in plain words, written here so the page shows no codes or ids. */

interface Line {
  outcome: "done" | "asked" | "skipped" | "failed";
  text: string;
}

const VERBS: Record<CaptainChore, { done: (n: number) => string; asked: (n: number) => string }> = {
  ship: { done: (n) => `shipped ${n}`, asked: (n) => `asked you about ${n}` },
  cards: { done: (n) => `answered ${n}`, asked: (n) => `left ${n} for you` },
  questions: { done: (n) => `answered ${n}`, asked: (n) => `left ${n} for you` },
  memory: { done: (n) => `sorted ${n} ${n === 1 ? "memory" : "memories"}`, asked: (n) => `${n} for you` },
  projects: { done: (n) => `updated ${n}`, asked: (n) => `asked you about ${n}` },
  triage: { done: (n) => `triaged ${n}`, asked: (n) => `${n} for you` },
  cleanup: { done: (n) => `cleaned up ${n}`, asked: (n) => `${n} for you` },
  followups: { done: (n) => `followed up on ${n}`, asked: (n) => `${n} for you` },
  discover: { done: (n) => `installed ${n}`, asked: (n) => `proposed ${n}` },
  tidy: { done: (n) => `tidied ${n}`, asked: (n) => `${n} for you` },
  health: { done: (n) => `fixed ${n}`, asked: (n) => `${n} for you` },
  checklist: { done: (n) => `fixed ${n}`, asked: (n) => `${n} for you` },
  map: { done: () => "updated the map", asked: (n) => `${n} for you` },
};

/** What a chore run did, from its log lines: "shipped 2, asked you about 1". Empty lines: "nothing to do". */
export function choreResult(chore: CaptainChore, lines: readonly Line[], note?: string): string {
  const done = lines.filter((l) => l.outcome === "done").length;
  const asked = lines.filter((l) => l.outcome === "asked").length;
  const failed = lines.filter((l) => l.outcome === "failed").length;
  const parts = [
    ...(done > 0 ? [VERBS[chore].done(done)] : []),
    ...(asked > 0 ? [VERBS[chore].asked(asked)] : []),
    ...(failed > 0 ? [`${failed} failed`] : []),
  ];
  if (parts.length > 0) return parts.join(", ");
  const stopped = lines.find((l) => l.outcome === "skipped");
  if (stopped !== undefined) return stopped.text.replace(/^[A-Z]/, (c) => c.toLowerCase());
  return note !== undefined && note !== "" ? note.replace(/^[A-Z]/, (c) => c.toLowerCase()) : "nothing to do";
}

/** A run that ended badly, or a check that found a problem, needs a look. */
export function needsLook(
  status: PlaybookRun["status"] | "none",
  findings: number,
  pack: string,
  held: boolean,
): boolean {
  if (held) return false;
  if (status === "failed" || status === "capped") return true;
  return status === "done" && findings > 0 && (pack === "engineering" || pack === "ops");
}

/** A playbook run as one plain line. */
export function runResult(run: Pick<PlaybookRun, "status" | "note" | "findings">): string {
  const note = run.note?.replace(/^[A-Z]/, (c) => c.toLowerCase());
  switch (run.status) {
    case "failed":
      return note === undefined ? "failed" : `failed: ${note}`;
    case "capped":
      return note ?? "stopped at its budget";
    case "stopped":
      return note ?? "stopped";
    case "nothing":
      return note ?? "nothing new";
    case "running":
      return "running";
    default:
      return note ?? `${run.findings} ${run.findings === 1 ? "finding" : "findings"}`;
  }
}
