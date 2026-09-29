import type { CommandOutput, UpdateStatus } from "@majhi/shared";

export type VersionInfo = CommandOutput<"system.version">;

export type UpdateNotice =
  | { kind: "none" }
  | {
      kind: "ready";
      /** Commit subjects, newest first. */
      changes: string[];
      dirty: boolean;
      /** False without a connected helper: the owner then gets the `make up` command instead of a button. */
      canUpdate: boolean;
    };

/** What the sidebar shows under the logo. */
export function updateNotice(version: VersionInfo | undefined): UpdateNotice {
  if (version === undefined || !version.updateReady) return { kind: "none" };
  return {
    kind: "ready",
    changes: version.changes,
    dirty: version.dirty === true,
    canUpdate: version.canUpdate === true,
  };
}

/** "3 changes" or "New code on disk", for the card's second line. */
export function changeSummary(changes: readonly string[]): string {
  if (changes.length === 0) return "New code is on disk";
  return changes.length === 1 ? "1 change" : `${changes.length} changes`;
}

const CLOCK_SLACK_MS = 2_000;

export type UpdatePhase =
  | { kind: "building"; lines: string[] }
  | { kind: "restarting"; lines: string[] }
  | { kind: "failed"; lines: string[]; error: string }
  | { kind: "back" };

/** Whether `/health` answers with the commit the update built, so the page can reload. */
export function isNewServer(healthCommit: string | undefined, target: string | undefined): boolean {
  if (healthCommit === undefined || target === undefined || target === "") return false;
  return healthCommit.startsWith(target) || target.startsWith(healthCommit);
}

/**
 * Where an update is, from what the two servers say. `status` is the helper's `update.json` as the
 * old server reads it (and the new one, after). `serverUp` is whether `/health` answered.
 */
export function updatePhase(input: {
  status: UpdateStatus | undefined;
  serverUp: boolean;
  healthCommit: string | undefined;
  startedAt: string;
}): UpdatePhase {
  const { status, serverUp, healthCommit } = input;
  // The helper and the browser share one clock; a little slack covers the click reaching the helper.
  const mine =
    status !== undefined && Date.parse(status.startedAt) >= Date.parse(input.startedAt) - CLOCK_SLACK_MS;
  const lines = mine ? status.lines : [];
  if (mine && status.state === "failed") {
    return { kind: "failed", lines, error: status.error ?? "The update failed." };
  }
  if (mine && status.commit !== "" && serverUp && isNewServer(healthCommit, status.commit)) {
    return { kind: "back" };
  }
  if (!serverUp || (mine && status.state === "done")) return { kind: "restarting", lines };
  return { kind: "building", lines };
}
