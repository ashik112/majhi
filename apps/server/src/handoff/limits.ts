import { availableParallelism } from "node:os";

/** Memory of a hand-off check when `containers.handoff_memory` is not set. */
export const DEFAULT_HANDOFF_MEMORY = "4g";

/**
 * CPUs of a hand-off check when `containers.handoff_cpus` is not set: half the cores, at least 2.
 * Checks are short and run one at a time per workspace, so they get more than an agent run's one CPU.
 */
export function defaultHandoffCpus(cores: number = availableParallelism()): number {
  return Math.min(16, Math.max(2, Math.floor(cores / 2)));
}
