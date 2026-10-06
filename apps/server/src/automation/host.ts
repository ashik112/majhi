import type { AgentStore } from "../agents/store.ts";
import { UserError } from "../errors.ts";
import type { ProcessManager } from "../processes/manager.ts";
import type { ProjectService } from "../projects/service.ts";
import type { Store } from "../store/index.ts";
import type { TaskService } from "../tasks/service.ts";
import type { ActionHost } from "./actions.ts";

export interface HostParts {
  store: Store;
  tasks: TaskService;
  processes: ProcessManager;
  projects: ProjectService;
  agents: AgentStore;
  /** Resumes the org's tasks a limit paused that nothing holds now. */
  resumeLimited: (org: string) => Promise<string[]>;
}

/** The pieces of majhi an action reaches, through the same service paths as the commands. */
export function createActionHost({
  store,
  tasks,
  processes,
  projects,
  agents,
  resumeLimited,
}: HostParts): ActionHost {
  return {
    projects: () => projects.infos(),
    agent: async (id) => {
      const entry = (await agents.list()).find((a) => a.ok && a.agent.frontmatter.id === id);
      return entry?.ok === true ? entry.agent.frontmatter : undefined;
    },
    task: (id) => {
      const task = store.tasks.get(id);
      return task === undefined
        ? undefined
        : {
            id: task.id,
            org: task.org,
            status: task.status,
            pausedReason: task.pausedReason,
            team: task.team,
          };
    },
    startTask: async (input) => {
      const task = await tasks.create({
        text: input.text,
        repos: [{ project: input.project }],
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.team === undefined ? {} : { team: input.team }),
        attachments: [],
        start: true,
        provenance: input.provenance,
      });
      return { id: task.id };
    },
    postToTask: (input) => tasks.postFromScheduler(input),
    startProcess: async (input) => {
      const task = tasks.get(input.task);
      const agent = task.team[0];
      if (agent === undefined) throw new UserError(`Task ${task.id} has no agent to run it.`, 409);
      const started = await processes.start({
        task: task.id,
        agent,
        command: input.command,
        name: input.name,
        cwd: input.cwd,
        wait: false,
      });
      return { id: started.id };
    },
    process: (task, id) => processes.get(task, id),
    resumeLimited,
  };
}
