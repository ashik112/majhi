import { z } from "zod";

/**
 * The merge rule: nothing merges into a target unless the hand-off checks are green for the exact
 * commit being merged. One function on the server decides (`MergeGate`); this is its typed answer.
 * No caller reads text to decide anything: the sentence and the button come from the verdict.
 */

/** A check the rule reads. `secret` is the diff scan: a hard block that nobody can override. */
export const MERGE_CHECK_NAMES = ["test", "build", "lint", "typecheck", "secret"] as const;
export const MergeCheckNameSchema = z.enum(MERGE_CHECK_NAMES);
export type MergeCheckName = z.infer<typeof MergeCheckNameSchema>;

export const MergeVerdictSchema = z.discriminatedUnion("kind", [
  /** May merge. `noChecks`: the project has none set up, so nothing was held. */
  z.object({ kind: z.literal("ok"), noChecks: z.literal(true).optional() }),
  /** A check is running for this commit: wait. */
  z.object({ kind: z.literal("running") }),
  /** A check failed on this exact commit. */
  z.object({ kind: z.literal("failed"), check: MergeCheckNameSchema }),
  /**
   * The first check (merges cleanly, committed, no card waits) failed on this commit: `why` says how.
   * `owner`: only the owner can clear it (a card waits for them), so no agent is asked to fix it.
   */
  z.object({ kind: z.literal("blocked"), why: z.string(), owner: z.literal(true).optional() }),
  /** The checks ran on an older commit (`ran`), or never ran. */
  z.object({ kind: z.literal("stale"), ran: z.boolean() }),
]);
export type MergeVerdict = z.infer<typeof MergeVerdictSchema>;

/** The verdict with the commit it is about: the owner types `head` to merge past a failed check. */
export const MergeChecksSchema = z.object({ verdict: MergeVerdictSchema, head: z.string() });
export type MergeChecks = z.infer<typeof MergeChecksSchema>;

export type MergeVerdictAction = "run-checks" | "fix-with-agent" | "wait" | "none";

/** What the owner can press for this verdict. */
export function mergeVerdictAction(verdict: MergeVerdict): MergeVerdictAction {
  switch (verdict.kind) {
    case "ok":
      return "none";
    case "running":
      return "wait";
    case "stale":
      return "run-checks";
    case "failed":
      return "fix-with-agent";
    case "blocked":
      return verdict.owner === true ? "none" : "fix-with-agent";
  }
}

/** Only a failed check the owner may judge can be merged past: never the secret scan. */
export function mergeCanBeOverridden(verdict: MergeVerdict): boolean {
  return verdict.kind === "failed" && verdict.check !== "secret";
}

/** One sentence for the verdict. */
export function mergeVerdictLine(verdict: MergeVerdict): string {
  switch (verdict.kind) {
    case "ok":
      return verdict.noChecks === true ? "No checks set up for this project." : "Checks are green.";
    case "running":
      return "Checks are still running for this commit. Merge when they pass.";
    case "failed":
      return verdict.check === "secret"
        ? "The diff holds what looks like a secret. It cannot merge."
        : `The ${verdict.check} check failed on this commit.`;
    case "blocked":
      return `Not ready: ${verdict.why}.`;
    case "stale":
      return verdict.ran
        ? "The checks ran on an older commit, so they say nothing about this one."
        : "No checks ran on this commit yet.";
  }
}
