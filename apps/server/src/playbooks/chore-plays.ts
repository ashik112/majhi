import type { Cadence, CaptainChore, QuietHours } from "@majhi/shared";
import { cadenceLabel } from "@majhi/shared";
import type { Workspace } from "../captain/runner.ts";
import { Catalog } from "./catalog.ts";
import { inQuiet, isDue } from "./schedule.ts";

/** The shared rule of a chore's schedule: its cadence, its quiet hours, and which last run it counts from. */
export function choreDue(
  cadence: Cadence,
  quiet: QuietHours | undefined,
  now: Date,
  tz: string,
  last: LastRuns,
): string | undefined {
  const from = cadence.kind === "daily" || cadence.kind === "weekly" ? last.worked : last.any;
  if (!isDue(cadence, from === undefined ? undefined : new Date(from), now, tz)) return undefined;
  if (inQuiet(quiet, now, tz)) return undefined;
  if (cadence.kind === "daily") return "Daily run";
  if (cadence.kind === "every" && cadence.minutes === 60) return "Hourly check";
  return cadenceLabel(cadence);
}

/**
 * How the upkeep chores are scheduled: by their playbooks. The captain asks this, and the playbook
 * scheduler answers it with the owner's changes applied. Without those changes (tests, a bare captain)
 * `DefaultChorePlays` answers from the shipped playbooks, which is the schedule the chores always had:
 * the daily ones once a day, the others once an hour.
 */
export interface LastRuns {
  any: string | undefined;
  worked: string | undefined;
}

export interface ChorePlaybooks {
  /** Whether the chore is on for the workspace. A disabled chore never starts, by schedule or event. */
  enabled(org: string, chore: CaptainChore): boolean;
  /**
   * Why a scheduled run starts now ("Daily run", "Hourly check"), or undefined when it is not due.
   * `any` is the start of its last run; `worked` the last that did not rest, which a daily schedule counts from.
   */
  due(org: string, chore: CaptainChore, ws: Pick<Workspace, "tz">, last: LastRuns): string | undefined;
}

export class DefaultChorePlays implements ChorePlaybooks {
  constructor(
    private readonly catalog = new Catalog(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  enabled(_org: string, _chore: CaptainChore): boolean {
    return true;
  }

  due(_org: string, chore: CaptainChore, ws: Pick<Workspace, "tz">, last: LastRuns): string | undefined {
    const cadence = this.catalog.ofChore(chore)?.trigger.cadence;
    if (cadence === undefined) return undefined;
    return choreDue(cadence, undefined, this.now(), ws.tz, last);
  }
}
