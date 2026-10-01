import { git } from "../../git/git.ts";
import type { ProcessManager } from "../../processes/manager.ts";
import type { ProjectService } from "../../projects/service.ts";
import type { Store } from "../../store/index.ts";
import type { UsageService } from "../../usage/service.ts";
import type { ActionHost } from "../actions.ts";
import type { WatchHost } from "./observe.ts";
import { pathPrint, urlPrint } from "./probe.ts";

export interface WatchHostParts {
  store: Store;
  processes: ProcessManager;
  projects: ProjectService;
  usage: UsageService;
  /** A command watch starts its process the way a `process.run` action does. */
  actions: Pick<ActionHost, "startProcess">;
}

/** The pieces of majhi a watch looks at. */
export function createWatchHost({ store, processes, projects, usage, actions }: WatchHostParts): WatchHost {
  return {
    projects: async () => (await projects.infos()).map((p) => ({ id: p.id, org: p.org, path: p.path })),
    tasks: () =>
      store.tasks.list(true).map((t) => ({
        id: t.id,
        org: t.org,
        status: t.status,
        pausedReason: t.pausedReason,
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
    pathPrint,
    urlPrint: (url) => urlPrint(url),
    startProcess: (input) => actions.startProcess(input),
  };
}
