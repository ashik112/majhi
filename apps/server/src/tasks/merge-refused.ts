import { type MergeVerdict, mergeCanBeOverridden, mergeVerdictLine } from "@majhi/shared";
import { UserError } from "../errors.ts";

/**
 * A merge the checks rule refused. Typed: callers that decide anything read `verdict`, never the
 * message. `head` is what the owner would type as `confirmChecks` to merge past a failed check.
 */
export class MergeRefused extends UserError {
  constructor(
    readonly verdict: MergeVerdict,
    readonly head: string,
    /** The caller sent `confirmChecks`, and it was not the head of this merge. */
    readonly wrongConfirm = false,
  ) {
    super(refusalLine(verdict, wrongConfirm), 409);
  }
}

function refusalLine(verdict: MergeVerdict, wrongConfirm: boolean): string {
  const line = mergeVerdictLine(verdict);
  if (wrongConfirm) return `${line} The commit you confirmed is not the one being merged.`;
  switch (verdict.kind) {
    case "stale":
      return `${line} Run the checks, then merge.`;
    case "failed":
      return mergeCanBeOverridden(verdict) ? `${line} Fix it, then merge.` : line;
    default:
      return line;
  }
}
