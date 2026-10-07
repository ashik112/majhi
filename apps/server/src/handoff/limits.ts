import { availableParallelism, totalmem } from "node:os";

const GIB = 1024 * 1024 * 1024;
/** What a Node build needs beyond its heap: the process itself, native code, a compiler's own memory. */
const HEAP_HEADROOM_MB = 1024;

/**
 * The most memory a hand-off check may use when nothing is set: a quarter of the machine, and at least
 * 6g where the machine has room for it (half of a small one). A container limit is a ceiling, not a
 * reservation, so a check that needs less leaves the rest free.
 */
export function defaultHandoffMemory(total: number = totalmem()): string {
  const gib = total / GIB;
  return `${Math.max(Math.floor(gib / 4), Math.min(6, Math.floor(gib / 2)), 1)}g`;
}

/** Megabytes in a size like `512m` or `6g`. */
export function memoryMb(size: string): number {
  const n = Number(size.slice(0, -1));
  return size.endsWith("g") ? n * 1024 : n;
}

/**
 * The memory a check's environment asks for: the Node heap in `NODE_OPTIONS` (`--max-old-space-size`, in
 * MB) and headroom. Undefined when the environment says nothing.
 */
export function impliedMemoryMb(env: Record<string, string>): number | undefined {
  for (const word of (env.NODE_OPTIONS ?? "").split(" ")) {
    const eq = word.indexOf("=");
    if (eq < 0) continue;
    const name = word.slice(0, eq).split("_").join("-");
    const n = Number(word.slice(eq + 1));
    if (name === "--max-old-space-size" && Number.isFinite(n) && n > 0) return n + HEAP_HEADROOM_MB;
  }
  return undefined;
}

/** "6 GB" for a size like `6g`. */
export function sizeWords(size: string): string {
  return size.endsWith("g") ? `${size.slice(0, -1)} GB` : `${size.slice(0, -1)} MB`;
}

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
