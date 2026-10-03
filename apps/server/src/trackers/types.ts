import type { TrackerConfig, TrackerItem, TrackerTestResult } from "@majhi/shared";

/**
 * One interface for the three trackers (SPEC 5.11). Each adapter talks to its tracker's REST API
 * with the `fetch` it is given, so tests never reach the network.
 */
export interface TrackerAdapter {
  /** Open items, at most 100. With `assignedToMe`, only those assigned to the token's user. */
  pull(opts: { assignedToMe: boolean }): Promise<TrackerItem[]>;
  get(key: string): Promise<TrackerItem>;
  comment(key: string, text: string): Promise<void>;
  /**
   * Moves the item to the status of that name, matched without regard to case. Jira goes through
   * the transition that leads there; GitHub Issues closes on `closed` and reopens on `open`.
   * Throws TrackerError naming the statuses it can reach when none matches.
   */
  setStatus(key: string, status: string): Promise<void>;
  /** Adds a link to the item: a remote link on Jira, a comment on ClickUp and GitHub Issues. */
  link(key: string, url: string, title: string): Promise<void>;
  /** Creates an item for a pushed task. */
  create(item: { title: string; body: string }): Promise<TrackerItem>;
  /** Reads who the token belongs to and that the project, list or repo is reachable. */
  test(): Promise<TrackerTestResult>;
}

/** What an adapter needs: the config, the token's value and a fetch. */
export interface TrackerAdapterInit<C extends TrackerConfig = TrackerConfig> {
  config: C;
  /** The token's value, for this adapter only. Never logged. */
  token: string;
  fetch: typeof fetch;
}

/** A tracker refused or failed. The message is safe to show: the token is removed from it. */
export class TrackerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
