import { LEGACY_PERSONAL, PRIVATE } from "./ids.ts";

/**
 * The ids setup picks for what it makes by itself: the workspace, the account, the lead agent and the captain.
 * Pure, so the one rule holds everywhere: an id that is taken is never reused and never replaced, the next free one is.
 */

/** The workspace setup makes on its own, and its name. `personal` is reserved for older configs, so the id is `me`. */
export const SETUP_ORG_ID = "me";
export const SETUP_ORG_NAME = "Personal";
export const SETUP_ORG_KEY = "PER";
/** The captain's id. A root agent that is already the captain is kept as it is. */
export const SETUP_CAPTAIN_ID = "majhi-boss";

/** What already exists, from the lists the page has just read. */
export interface SetupTaken {
  orgs: readonly string[];
  accounts: readonly string[];
  /** Every agent id, of every workspace and of the root. */
  agents: readonly string[];
  /** The agent that is the captain now, when there is one. */
  captain?: string | undefined;
}

export interface SetupPlan {
  org: { id: string; name: string };
  account: string;
  lead: string;
  /** `existing`: a captain is set already, so none is made. */
  captain: { id: string; existing: boolean };
}

/** `base`, else `base-2`, `base-3`, ... the first one `taken` does not hold. */
export function freeId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!used.has(id)) return id;
  }
}

/** The ids for a first sign-in with `tool`: all free, whatever is already there. */
export function planSetup(tool: string, taken: SetupTaken): SetupPlan {
  const orgId = freeId(SETUP_ORG_ID, [...taken.orgs, PRIVATE, LEGACY_PERSONAL, "root"]);
  const nth = orgId === SETUP_ORG_ID ? undefined : orgId.slice(SETUP_ORG_ID.length + 1);
  return {
    org: { id: orgId, name: nth === undefined ? SETUP_ORG_NAME : `${SETUP_ORG_NAME} ${nth}` },
    account: freeId(`${tool}-${orgId}`, taken.accounts),
    lead: freeId(`${orgId}-lead`, taken.agents),
    captain:
      taken.captain === undefined
        ? { id: freeId(SETUP_CAPTAIN_ID, taken.agents), existing: false }
        : { id: taken.captain, existing: true },
  };
}
