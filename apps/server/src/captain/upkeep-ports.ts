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

export interface HealthCheckView {
  id: string;
  group: string;
  label: string;
  ok: boolean;
  detail: string;
  fix?: { label: string } | undefined;
}

export interface UpkeepPorts {
  /** What the workspace's projects and connections use, as search words (languages, frameworks, services). */
  profile(org: string): Promise<string[]>;
  search(kind: Candidate["kind"], term: string): Promise<Candidate[]>;
  /** Installs a skill (preview, then confirm). It is enabled for no agent. */
  installSkill(org: string, skill: Candidate): Promise<void>;

  /** Stale inbox items, old previews, dead watches, items that wait for the owner too long. */
  tidy(org: string): Promise<Signal[]>;
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

/** The most slots per account the captain raises to on its own. */
export const MAX_ACCOUNT_SLOTS = 4;
