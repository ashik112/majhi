import { scrubSecrets } from "./scrub.ts";
import {
  type DeployContext,
  DeployProblem,
  type DeployProvider,
  type ProviderDeps,
  type RunHandle,
} from "./types.ts";

/**
 * Deploy by running the owner's fixed command on one of the workspace's ssh hosts, through the same
 * connection majhi runs host commands with (its own agent, BatchMode, stdin closed). The command is the
 * string the owner wrote when they set the target: nothing is added to it, and no task text reaches it.
 */

const LOG_LINES = 40;

/** The last lines of a command's output, for the record and an incident. Secrets in it are replaced. */
export function tailOf(output: string): string {
  const lines = output.split("\n").filter((l) => l.trim() !== "");
  return scrubSecrets(lines.slice(-LOG_LINES).join("\n"));
}

async function run(
  ctx: DeployContext,
  deps: ProviderDeps,
  connection: string,
  command: string,
): Promise<RunHandle> {
  const host = await deps.credentials.ssh(ctx.org, connection);
  if ("problem" in host) throw new DeployProblem(host.problem);
  const done = await deps.remote(host.alias, command, host.key);
  if (done.code === 0) return { id: "ssh", outcome: { state: "success" } };
  const why =
    done.code === null ? "ssh could not run it or it ran out of time" : `it exited with ${done.code}`;
  return {
    id: "ssh",
    outcome: { state: "failed", detail: `The command failed: ${why}\n${tailOf(done.output)}` },
  };
}

export function createSshProvider(deps: ProviderDeps): DeployProvider {
  return {
    preflight: async () => undefined,
    start(ctx) {
      const via = ctx.target.via;
      if (via.kind !== "ssh") throw new DeployProblem("This target is not an ssh command.");
      return run(ctx, deps, via.connection, via.command);
    },
    async poll(_ctx, handle) {
      // The command ended before `start` returned; asking again gives the same answer.
      return handle.outcome ?? { state: "failed", detail: "majhi restarted while the command ran" };
    },
  };
}

/** The owner's rollback command, on its own connection. */
export function runRollbackCommand(
  ctx: DeployContext,
  deps: ProviderDeps,
  connection: string,
  command: string,
): Promise<RunHandle> {
  return run(ctx, deps, connection, command);
}
