import type Database from "better-sqlite3";
import type { CrmService } from "../business/crm.ts";
import type { DeadlinesService } from "../business/deadlines.ts";
import type { KbService } from "../business/kb.ts";
import type { VoiceService } from "../business/voice.ts";
import type { FindingsService } from "../findings/service.ts";
import type { Parsed } from "../memory/housekeeper.ts";
import type { GoalsService } from "../playbooks/goals.ts";
import type { OutboundGate } from "../playbooks/outbound.ts";
import type { CardRepo } from "../projectcard/repo.ts";
import type { SensorCache } from "../sensors/cache.ts";

/**
 * What the growth playbooks and views need from majhi, as one small set of ports. Each is a service
 * the rest of majhi already has; nothing here reaches past them.
 */

/** Asks the smallest model one question; undefined when none is set. Throws when the model fails. */
export type Writer = <T>(
  task: { id: string; org: string },
  prompt: string,
  parse: (reply: string) => Parsed<T>,
) => Promise<T | undefined>;

export interface GrowthDeps {
  db: Database.Database;
  now: () => Date;
  findings: FindingsService;
  kb: KbService;
  voice: VoiceService;
  crm: CrmService;
  deadlines: DeadlinesService;
  goals: GoalsService;
  cards: CardRepo;
  outbound: OutboundGate;
  cache: SensorCache;
  orgName: (org: string) => Promise<string>;
  /** The smallest model. */
  write: Writer;
}

/** Tags that mark a contact as the client's main one. */
export const MAIN_CONTACT_TAGS = ["main-contact", "main contact", "main", "primary"] as const;
