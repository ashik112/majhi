import type { PausedReason, ProcessInfo, RepoMr, TaskStatus, UsageTotals } from "@majhi/shared";
import type { ActionHost } from "../../automation/actions.ts";
import { git } from "../../git/git.ts";
import type { ProcessManager } from "../../processes/manager.ts";
import type { Store } from "../../store/index.ts";
import type { UsageService } from "../../usage/service.ts";

/** A task as a watch sees it. */
export interface WatchTask {
  id: string;
  /** Absent for a task that belongs to no org. */
  org: string | undefined;
  status: TaskStatus;
  pausedReason: PausedReason | undefined;
  /** The first repo's project, where a task started by a watch opens. */
  project: string | undefined;
  /** The merge requests of its repos. Read when asked, since most watches do not need them. */
  mrs(): { project: string; mr: RepoMr }[];
}

/** The part of majhi the task, process, usage, branch and command watches look at. Tests stand in for it. */
export interface WatchHost {
  tasks(): WatchTask[];
  processes(task: string): ProcessInfo[];
  process(task: string, id: string): ProcessInfo | undefined;
  /** What the org used over the period. */
  usage(org: string, period: "today" | "week" | "month"): UsageTotals;
  /** The commit a local branch points at, or undefined when there is no such branch. */
  branchTip(checkout: string, branch: string): Promise<string | undefined>;
  /** Starts the command as a process of the task, which does not wake the agent. */
  startProcess(input: {
    task: string;
    command: string;
    name: string | undefined;
    cwd: string | undefined;
  }): Promise<{ id: string }>;
}

export interface WatchHostParts {
  store: Store;
  processes: ProcessManager;
  usage: UsageService;
  /** A command watch starts its process the way a `process.run` action does. */
  actions: Pick<ActionHost, "startProcess">;
}

/** The pieces of majhi a watch looks at. */
export function createWatchHost({ store, processes, usage, actions }: WatchHostParts): WatchHost {
  return {
    tasks: () =>
      store.tasks.list(true).map((t) => ({
        id: t.id,
        org: t.org,
        status: t.status,
        pausedReason: t.pausedReason,
        project: store.tasks.get(t.id)?.repos[0]?.project,
        mrs: () =>
          (store.tasks.get(t.id)?.repos ?? []).flatMap((r) =>
            r.mr === undefined ? [] : [{ project: r.project, mr: r.mr }],
          ),
      })),
    processes: (task) => processes.list(task),
    process: (task, id) => processes.get(task, id),
    usage: (org, period) => usage.breakdown({ by: "day", range: period, filters: { org }, limit: 1 }).total,
    branchTip: async (checkout, branch) => {
      try {
        const out = await git(checkout, [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${branch}^{commit}`,
        ]);
        return out.trim() || undefined;
      } catch {
        return undefined;
      }
    },
    startProcess: (input) => actions.startProcess(input),
  };
}
