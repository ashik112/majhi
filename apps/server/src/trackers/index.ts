import { ClickUpAdapter } from "./clickup.ts";
import { GitHubIssuesAdapter } from "./github.ts";
import { JiraAdapter } from "./jira.ts";
import type { TrackerAdapter, TrackerAdapterInit } from "./types.ts";

export type { TrackerAdapter, TrackerAdapterInit } from "./types.ts";
export { TrackerError } from "./types.ts";

/** The adapter for the tracker the config names. */
export function createAdapter(init: TrackerAdapterInit): TrackerAdapter {
  const { config } = init;
  switch (config.type) {
    case "jira":
      return new JiraAdapter({ ...init, config });
    case "clickup":
      return new ClickUpAdapter({ ...init, config });
    case "github":
      return new GitHubIssuesAdapter({ ...init, config });
  }
}
