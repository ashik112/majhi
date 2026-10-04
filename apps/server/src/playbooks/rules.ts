import type { Playbook } from "@majhi/shared";
import type { FindingsService } from "../findings/service.ts";

/**
 * The playbooks that run as code and need no model (cost tier "rules"). A run reads what the owner
 * listed, files findings through the findings store and reports how many it filed. What it reads is
 * data, and nothing it reads is an instruction.
 */

export interface RulesContext {
  org: string;
  playbook: Playbook;
  /** What the owner filled in, one list of lines per setting. */
  settings: Readonly<Record<string, readonly string[]>>;
  findings: FindingsService;
  /** The owner pressed Run now: look at everything, whatever was looked at lately. */
  manual?: boolean;
  now: () => Date;
  fetch: typeof fetch;
}

export interface RulesResult {
  /** Findings it filed or refreshed. */
  findings: number;
  /** One line for the history; empty when nothing happened. */
  note: string;
  /** Something to wake the captain with, when a finding is news. The findings store wakes it already. */
}

export interface RulesRunner {
  run(ctx: RulesContext): Promise<RulesResult>;
  /** A problem with the owner's settings, or undefined. */
  check?(settings: Readonly<Record<string, readonly string[]>>): string | undefined;
}

/** The rules runners that ship with the playbooks themselves. The ops watch and the sensors register theirs. */
export const RULES_RUNNERS: Readonly<Record<string, RulesRunner>> = {};
