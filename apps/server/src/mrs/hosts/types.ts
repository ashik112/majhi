import type { CiState, MrHost, MrState } from "@majhi/shared";

/**
 * One interface for the three MR hosts (SPEC 5.5): open, update the description, read state and
 * CI, merge. GitHub goes through `gh`, GitLab through `glab`, Bitbucket Cloud through its REST API.
 */

/** Which repository on which host, and the credential to reach it with. */
export interface MrTarget {
  host: MrHost;
  /** `owner/repo`, or `group/subgroup/repo`. */
  slug: string;
  /** A self-hosted host name, when it is not the public one. */
  hostName?: string | undefined;
  /** The token for this call only. Never logged, never stored on the target's owner. */
  token?: string | undefined;
}

export interface OpenMr {
  /** The task branch. */
  head: string;
  /** The branch the MR merges into. */
  base: string;
  title: string;
  body: string;
}

export interface MrStatus {
  state: MrState;
  ci: CiState;
  url: string;
}

export interface MrHostClient {
  open(target: MrTarget, mr: OpenMr): Promise<{ url: string; number: number }>;
  updateDescription(target: MrTarget, number: number, mr: { title: string; body: string }): Promise<void>;
  status(target: MrTarget, number: number): Promise<MrStatus>;
  /**
   * Asks the host to merge. A host may only queue the merge (GitLab "when the pipeline succeeds"),
   * so read `status` afterwards for the outcome.
   */
  merge(target: MrTarget, number: number): Promise<void>;
}

/** A host or its CLI refused or failed. The message is safe to show: the token is removed from it. */
export class MrHostError extends Error {}

/** Replaces every occurrence of the token, so a CLI or HTTP error cannot carry it into the room. */
export function scrub(text: string, token: string | undefined): string {
  return token === undefined || token === "" ? text : text.split(token).join("[token]");
}
