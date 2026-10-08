import { SKILL_NAME } from "@majhi/shared";

/**
 * What the self-upkeep chores (discover, tidy, health, checklist) read and do in majhi. The real ports
 * are built in `upkeep-world.ts` from majhi's own commands; tests play them.
 */

/** A tool that could help: an MCP server or a skill. */
export interface Candidate {
  kind: "mcp" | "skill";
  /** The registry name or the skill id: what the owner rejected is remembered by it. */
  id: string;
  title: string;
  description: string;
  /** The repo to review. */
  source?: string | undefined;
  installs?: number | undefined;
  installed: boolean;
  /** For a skill: what skills.search says to pass to skills.install. */
  install?: { source: string; skill?: string | undefined } | undefined;
}

/**
 * What skills.install takes for a searched skill: the search's own install pair, when its skill name
 * is a valid local name (a registry id like `react:components` is not one). Undefined otherwise, so the
 * captain proposes the skill instead of failing to install it.
 */
export function skillInstallInput(c: Candidate): { source: string; skill: string } | undefined {
  const pair = c.install;
  if (pair?.skill === undefined || !SKILL_NAME.test(pair.skill)) return undefined;
  return { source: pair.source, skill: pair.skill };
}

export type Severity = "info" | "low" | "medium" | "high";

/** Something worth the owner's eye. The key makes two reports of it the same thing. */
export interface Signal {
  key: string;
  title: string;
  detail: string;
  severity: Severity;
  project?: string | undefined;
}

/** Agent slots of one account, and whether it has room to run more at once. */
export interface AccountSlots {
  account: string;
  inUse: number;
  waiting: number;
  limit: number;
  free: number;
  /** The account's weekly use is well under its budget. The machine reading is not checked: majhi has none yet. */
  headroom: boolean;
}

/** A secret request that waited for the owner past the stale limit, and whether anything still needs it. */
export interface StaleSecret {
  task: string;
  item: string;
  label: string;
  /** Why it is no longer needed. Absent while the task is open and the secret is not saved. */
  obsolete?: string | undefined;
}

export interface HealthCheckView {
  id: string;
  group: string;
  label: string;
  ok: boolean;
  detail: string;
  fix?: { label: string } | undefined;
}

/**
 * What the watch-coverage chore reads of a workspace: where each project is deployed and how it can be checked, the
 * watches that exist, what is connected, and what broke before. Facts only: which watch to add is the captain's call.
 */
export interface WatchCoverage {
  projects: { id: string; environments: { env: string; tier: string; check?: string | undefined }[] }[];
  watches: { id: string; name: string; kind: string; target?: string | undefined; paused: boolean }[];
  connections: { id: string; type: string; name: string }[];
  /** The newest incidents of the workspace's watches and tasks, to see what broke before. */
  incidents: { title: string; status: string }[];
}

export interface UpkeepPorts {
  /** The facts the watch-coverage chore hands the captain. */
  watchCoverage?(org: string): Promise<WatchCoverage>;
  /** What the workspace's projects and connections use, as search words (languages, frameworks, services). */
  profile(org: string): Promise<string[]>;
  search(kind: Candidate["kind"], term: string): Promise<Candidate[]>;
  /** Installs a skill (preview, then confirm). It is enabled for no agent. */
  installSkill(org: string, skill: Candidate): Promise<void>;

  /** Stale inbox items, old previews, dead watches, items that wait for the owner too long. */
  tidy(org: string): Promise<Signal[]>;
  /**
   * Pending secret requests of the workspace's tasks that are no longer needed: a duplicate of an
   * older pending request for the same secret (at once), or one that waited more than 3 days and
   * whose task closed or whose secret was saved another way.
   */
  staleSecrets(org: string): Promise<StaleSecret[]>;
  /** Ids of the workspace's pending secret requests (`task/item`), oldest first. The captain's lane tries to fetch them through a connection. */
  pendingSecrets?(org: string): Promise<string[]>;
  /** Wakes the workspace's captain lane with a line; its digest lists the requests. */
  wakeCaptain?(org: string, line: string): void;
  /** Ends a stale secret request: the asking agent is told it was withdrawn and why. */
  withdrawSecret(task: string, item: string, reason: string): Promise<void>;
  /** Connections whose last test failed. */
  failingConnections(org: string): Promise<{ id: string; name: string }[]>;
  /** Tests it again: true when it passes now. */
  retest(connection: string): Promise<boolean>;

  health(): Promise<HealthCheckView[]>;
  healthFix(id: string): Promise<{ ok: boolean; detail: string; needsOwner: boolean }>;
  reportBug(title: string, details: string): Promise<void>;

  /** Backups, disk, budgets and the like, as findings. */
  checklist(org: string): Promise<Signal[]>;
  slots(): Promise<AccountSlots[]>;
  /** Why the machine cannot take more agents at once now, or undefined. */
  machineBusy?(): string | undefined;
  /** Sets the limit of agents at once on one account. */
  setAccountSlots(limit: number): Promise<void>;
}

/** The project wiki as the wiki chore sees it. The real port is the wiki service. */
export interface WikiPorts {
  /** The wiki is on for the workspace (`wikiEnabled`). */
  enabled(org: string): Promise<boolean>;
  /** The projects whose wiki was built and is behind the base branch now. */
  stale(org: string): Promise<{ projects: string[] }>;
  /** The one update action, waited for. `summary` is the log line's tail. */
  update(org: string): Promise<{ summary: string }>;
}

/** The most slots per account the captain raises to on its own. */
export const MAX_ACCOUNT_SLOTS = 4;
