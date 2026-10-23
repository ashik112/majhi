import type { DeployEnvironment } from "@majhi/shared";
import { parseLine, ShellParseError } from "../connections/shell.ts";

/**
 * A raw push or a job play to a project that majhi deploys from its CI asks the owner as any push does, and its card
 * names the better way: the task's deploy plan, one click for every target. Read from the parsed command line (its
 * words), never from the text around it.
 */

export const ONE_CLICK_DEPLOY =
  "This project has a deploy majhi can run: plan the task's deploy with projects.planDeploy, and the owner deploys every target with one click (push, build, deploy, check), so do not push or play jobs one by one.";

/** What a project's deploy recipes go through: the remotes their runs name, and whether they play jobs. */
export interface DeployFacts {
  remotes: ReadonlySet<string>;
  jobs: boolean;
}

/** The remotes and job plays of the environments that have a recipe. */
export function deployFactsOf(environments: readonly DeployEnvironment[]): DeployFacts {
  const remotes = new Set<string>();
  let jobs = false;
  for (const env of environments) {
    for (const run of [...(env.recipe?.deploy ?? []), ...(env.recipe?.builds ?? [])]) {
      if ("remote" in run) remotes.add(run.remote);
      if (run.kind === "gitlab-job") jobs = true;
    }
  }
  return { remotes, jobs };
}

/** The sentence for a command that pushes to a remote the project deploys through, or plays a job; else undefined. */
export function deployWayOf(command: string, facts: DeployFacts): string | undefined {
  if (facts.remotes.size === 0 && !facts.jobs) return undefined;
  let parsed: ReturnType<typeof parseLine>;
  try {
    parsed = parseLine(command);
  } catch (err) {
    if (err instanceof ShellParseError) return undefined;
    throw err;
  }
  for (const { words } of parsed.commands) {
    const program = (words[0] ?? "").split("/").at(-1);
    if (program === "git") {
      const push = words.indexOf("push");
      const remote = push === -1 ? undefined : words.slice(push + 1).find((w) => !w.startsWith("-"));
      if (remote !== undefined && facts.remotes.has(remote)) return ONE_CLICK_DEPLOY;
    }
    if (facts.jobs && words.some((w) => w.includes("/jobs/") && w.endsWith("/play"))) return ONE_CLICK_DEPLOY;
  }
  return undefined;
}
