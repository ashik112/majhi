import { useDecisions } from "@/lib/decision-queries";
import { workCountsOf } from "./model";

/**
 * The count of what waits for the owner, from `decisions.list` and nothing else. The sidebar, the bell,
 * the tab title, the Board's readout, the banner, the Captain page and the Decisions page all read it
 * here, so no screen can show another number. `org` narrows it to one workspace. Undefined until loaded.
 */
export function useNeedsYou(org?: string): number | undefined {
  return workCountsOf(useDecisions().data?.counts, org)?.needsYou;
}

/** The tasks an agent is working on right now, from the same server count. Undefined until loaded. */
export function useWorking(org?: string): number | undefined {
  return workCountsOf(useDecisions().data?.counts, org)?.working;
}
