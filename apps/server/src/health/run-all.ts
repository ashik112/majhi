/** One thing a full run checks: an account, a connection, or the doctor checks as a group. */
export interface CheckUnit {
  id: string;
  /** How many rows of the page it settles: the doctor group settles all of its rows at once. */
  weight: number;
  /** Does the check and stores its result. May throw: the run goes on without it. */
  run: () => Promise<void>;
}

export interface UnitOutcome {
  unit: CheckUnit;
  /** Set when `run` threw. */
  error?: unknown;
}

/**
 * Runs every unit, at most `concurrency` at once. A unit that throws is reported and never stops the
 * others. `onDone` is told after each unit, in the order they finish. Resolves when all are done.
 */
export async function runUnits(
  units: readonly CheckUnit[],
  concurrency: number,
  onDone: (outcome: UnitOutcome) => void | Promise<void>,
): Promise<UnitOutcome[]> {
  const outcomes: UnitOutcome[] = [];
  let next = 0;
  const worker = async () => {
    while (next < units.length) {
      const unit = units[next++];
      if (unit === undefined) return;
      const outcome: UnitOutcome = { unit };
      try {
        await unit.run();
      } catch (error) {
        outcome.error = error;
      }
      outcomes.push(outcome);
      try {
        await onDone(outcome);
      } catch {
        // A listener that fails must not end the worker: the rest of the run still matters.
      }
    }
  };
  const width = Math.max(1, Math.min(concurrency, units.length));
  await Promise.all(Array.from({ length: width }, worker));
  return outcomes;
}
