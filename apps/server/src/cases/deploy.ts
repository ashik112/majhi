import { type DeployEnvironment, type DeployRecord, type DeployRunStep, deployIsActive } from "@majhi/shared";
import { UserError } from "../errors.ts";

/**
 * The captain's deploy of a case's fix (docs/briefs/instructions.md). Nothing here is a second way to deploy: the
 * fix lands the way a task's work lands (the merge rule and its hand-off checks), and the deploy is the deploy
 * service's own, with the runs the project already deployed with. The only new thing is how a case finds the path
 * it may repeat, and that it waits for the answer.
 */

export interface CaseDeployPorts {
  /** The environments of a project. */
  environments(project: string): Promise<readonly DeployEnvironment[]>;
  /** The newest live deploy of an environment, with the runs that made it. */
  latestLive(project: string, env: string): DeployRecord | undefined;
  /** Whether those runs can be put back for an earlier commit. */
  repeatable(runs: readonly DeployRunStep[]): boolean;
  /** Whether the project's remote is on a host the runs reach: the landed commit is pushed before it deploys. */
  onHost(project: string): Promise<boolean>;
  /** The hand-off checks of the case's head, run once per head. Not ok: why. */
  checks(task: string): Promise<{ ok: true } | { ok: false; why: string }>;
  /**
   * Lands the task's branch in its base: the one merge, which refuses a head whose checks did not pass. With `push`
   * the base is pushed after it. Throws a `UserError` with the reason when git or the merge rule refuses.
   */
  land(task: string, project: string, push: boolean): Promise<void>;
  deploy(
    input: { project: string; env: string; runs: DeployRunStep[]; task: string },
    actor: "captain",
  ): Promise<{ record: DeployRecord; repeat: boolean }>;
  rollback(id: number, actor: "captain"): Promise<{ record: DeployRecord; repeat: boolean }>;
  record(id: number): DeployRecord | undefined;
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Time between looks at the deploy, and the longest the captain's call waits for it. */
  pollMs: number;
  waitMs: number;
}

/** The deploy a case may repeat: the environment, the runs it went live with, and the version it runs now. */
export type DeployPath =
  | { ok: true; env: DeployEnvironment; runs: DeployRunStep[]; previous: string }
  | { ok: false; why: string };

const NO_PATH = (project: string): string =>
  `${project} has no deploy majhi can repeat: no environment of it went live through a run the captain may start and put back. Ask the owner once with case_ask how to deploy it.`;

/**
 * The project's own deploy path: an environment that went live before, through runs that can start again and be put
 * back, and that are not an ssh command (those are the owner's). Production-tier environments come first. One path
 * only: when several fit, the captain does not guess which one the client's symptom is on.
 */
export async function knownPath(ports: CaseDeployPorts, project: string): Promise<DeployPath> {
  const found: { env: DeployEnvironment; runs: DeployRunStep[]; previous: string }[] = [];
  for (const env of await ports.environments(project)) {
    const live = ports.latestLive(project, env.env);
    if (live === undefined || live.runs.length === 0) continue;
    if (live.runs.some((r) => r.kind === "ssh") || !ports.repeatable(live.runs)) continue;
    found.push({ env, runs: live.runs, previous: live.commit });
  }
  const production = found.filter((f) => f.env.tier === "production");
  const fit = production.length > 0 ? production : found;
  if (fit.length === 0) return { ok: false, why: NO_PATH(project) };
  const [only, ...more] = fit;
  if (only === undefined) return { ok: false, why: NO_PATH(project) };
  if (more.length > 0) {
    const names = fit.map((f) => f.env.env).join(", ");
    return {
      ok: false,
      why: `${project} deploys to several environments (${names}) and the captain does not pick one. Ask the owner once with case_ask which one.`,
    };
  }
  return { ok: true, ...only };
}

export class CaseDeployer {
  constructor(private readonly ports: CaseDeployPorts) {}

  path(project: string): Promise<DeployPath> {
    return knownPath(this.ports, project);
  }

  checks(task: string): Promise<{ ok: true } | { ok: false; why: string }> {
    return this.ports.checks(task);
  }

  /**
   * Lands the branch (unless it landed already) and deploys it to the environment with the runs of its path, then
   * waits until the deploy is live or failed. A failed deploy was rolled back by the deploy service itself.
   */
  async run(input: {
    task: string;
    project: string;
    env: string;
    runs: DeployRunStep[];
    landed: boolean;
  }): Promise<DeployRecord> {
    if (!input.landed)
      await this.ports.land(input.task, input.project, await this.ports.onHost(input.project));
    const started = await this.ports.deploy(
      { project: input.project, env: input.env, runs: input.runs, task: input.task },
      "captain",
    );
    return this.settled(started.record);
  }

  /** The record once it is no longer moving. A deploy still moving after the wait is a failure the captain reads. */
  private async settled(first: DeployRecord): Promise<DeployRecord> {
    const until = this.ports.now().getTime() + this.ports.waitMs;
    let record = first;
    while (deployIsActive(record.state)) {
      if (this.ports.now().getTime() >= until) {
        throw new UserError(
          `The deploy is still going after ${Math.round(this.ports.waitMs / 60_000)} minutes. majhi keeps following it; read the project's deploys before you go on.`,
          409,
        );
      }
      await this.ports.sleep(this.ports.pollMs);
      record = this.ports.record(first.id) ?? record;
    }
    return record;
  }

  /** Puts the version the deploy replaced back, through the same runs. */
  async rollback(record: number): Promise<DeployRecord> {
    return (await this.ports.rollback(record, "captain")).record;
  }
}
