import { availableParallelism } from "node:os";

/** Memory of a hand-off check when `containers.handoff_memory` is not set. */
export const DEFAULT_HANDOFF_MEMORY = "4g";

/** CPU weight of a hand-off check under contention. Agent runs and the server keep Docker's default 1024. */
export const HANDOFF_CPU_SHARES = "256";

/**
 * CPUs of a hand-off check when `containers.handoff_cpus` is not set: a sixth of the cores, at least
 * 2. A check is a build or a test run that uses every CPU it gets, so it must not take the machine.
 */
export function defaultHandoffCpus(cores: number = availableParallelism()): number {
  return Math.min(16, Math.max(2, Math.floor(cores / 6)));
}

/**
 * Checks that run at once across majhi: as many as fit in a third of the cores at the default CPUs,
 * at least 1 and at most 2. On 10 cores that is 1 check of 2 CPUs.
 */
export function defaultHandoffParallel(cores: number = availableParallelism()): number {
  return Math.min(2, Math.max(1, Math.floor(cores / 3 / defaultHandoffCpus(cores))));
}
