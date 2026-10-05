import { dockerSpawner, type RunnerConfig, type RuntimeOptions, removeStaleRunners } from "@majhi/acp";
import type { ServerEnv } from "../env.ts";
import { errorMessage } from "../errors.ts";
import { dockerInspect, type Inspect, RunnerNetwork } from "./network.ts";

export interface Runner {
  network: RunnerNetwork;
  /** How every run container is started, and what it may mount. */
  config: RunnerConfig;
  /** Removes this majhi's runner containers that no live run holds. */
  prune(): Promise<string[]>;
  /** Names of the run containers this majhi's live runs hold. */
  live(): string[];
  /** Removes run containers no live run holds, left by a restart or crash. Returns their names. */
  sweep(): Promise<string[]>;
}

/**
 * Where agent sessions run. With MAJHI_RUNNER=container each session gets its own runner
 * container (Phase 2c); containers a previous majhi left are removed first, and none starts
 * before majhi knows the runner network, so its guard can tell runner requests apart.
 */
export function runnerSetup(
  env: ServerEnv,
  inspect: Inspect | undefined,
  /** The networks a run of a task joins besides the runner network. Bound late by the caller. */
  taskNetworks?: (task: string) => string[],
): { sessionOptions: RuntimeOptions; runner: Runner | undefined } {
  const r = env.runner;
  if (r.mode !== "container") return { sessionOptions: env.runtime, runner: undefined };
  const network = new RunnerNetwork(r.network, inspect ?? dockerInspect(r.docker, r.cliEnv));
  const cleaned = removeStaleRunners({ docker: r.docker, cliEnv: r.cliEnv });
  const config: RunnerConfig = {
    image: r.image,
    network: r.network,
    docker: r.docker,
    user: r.user,
    memory: r.memory,
    cpus: r.cpus,
    cliEnv: r.cliEnv,
    majhiHome: env.majhiHome,
    protectedPaths: [env.secretsKeyFile],
    taskNetworks,
    ready: async () => {
      await cleaned;
      await network.ensure();
    },
  };
  void network.ensure().catch((err: unknown) => console.error(errorMessage(err)));
  const spawner = dockerSpawner(config);
  return {
    sessionOptions: { ...env.runtime, spawner },
    runner: { network, config, prune: () => spawner.prune(), live: () => spawner.live(), sweep: () => spawner.sweep() },
  };
}
