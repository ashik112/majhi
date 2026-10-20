import {
  type Brief,
  type BriefFacts,
  type BriefListInput,
  type Finding,
  type OwnerDecision,
  PRIVATE,
} from "@majhi/shared";
import { localDay } from "../usage/ranges.ts";
import type { Overnight } from "./overnight.ts";
import type { BriefRepo } from "./repo.ts";
import { briefDue, ownerZone } from "./time.ts";
import { oneLine, pushText, type Writer, writeBrief } from "./words.ts";

/** The longest the overnight span reaches back: a server that was off for days still briefs about one night. */
const SPAN_MAX_MS = 36 * 3_600_000;
/** How many briefs `brief.list` returns at most. */
const LIST_MAX = 60;

export interface BriefDeps {
  repo: BriefRepo;
  /** The brief hour (`HH:MM`) and zone: the autonomy settings' `brief_at` and `tz`. */
  clock: () => Promise<{ at: string; tz?: string | undefined }>;
  /** Every workspace that gets a brief, Private included. */
  orgs: () => Promise<{ id: string; name: string }[]>;
  /** What waits for the owner now, every workspace. A decision belongs to its org, Private for a task of none. */
  decisions: () => Promise<OwnerDecision[]>;
  /** Every finding, newest first. */
  findings: () => Finding[];
  /** A finding the owner does not want counted in the brief (its playbook's "tell me in the brief" is off). */
  briefHidden?: ((f: Finding) => boolean) | undefined;
  /** What Autonomous did in one workspace in a span. Only that workspace's records are read. */
  overnight: (
    from: string,
    to: string,
    org: string,
  ) => Promise<Overnight & { took: number; spent: number; budget?: number }>;
  /** The captain's queue titles in one workspace. */
  next: (org: string, max: number) => string[];
  /** The model that words a brief. Absent or failing: the template. */
  write?: Writer | undefined;
  /** The one combined push of the morning, to the owner's alert channels. Muted kinds and quiet hours are its business. */
  tell?: ((day: string, text: string) => void) | undefined;
  /** Puts the brief in the workspace's own captain conversation as a line. It never wakes the captain. */
  chatLine?: ((org: string, day: string, lines: readonly string[]) => Promise<void>) | undefined;
  changed?: (() => void) | undefined;
  now?: (() => Date) | undefined;
  /** How long the model gets. Tests shorten it. */
  modelTimeoutMs?: number | undefined;
}

/** A brief with nothing in it: no work, no findings, nothing waiting. It is stored so it is not made again, never shown. */
function isQuiet(f: BriefFacts): boolean {
  return (
    f.took === 0 &&
    f.shipped === 0 &&
    f.merged === 0 &&
    f.failed === 0 &&
    f.spent === 0 &&
    f.findingsNew === 0 &&
    f.findingsFixed === 0 &&
    f.captainDecided === 0 &&
    f.captainUpkeep === 0 &&
    f.needs.count === 0
  );
}

/**
 * The morning brief per workspace (docs/briefs/captain.md). Each workspace's brief is made from that workspace's
 * records only and worded by the smallest model from only those facts, so nothing of one workspace reaches the
 * prompt or the text of another. One combined push a morning goes to the owner's own channels.
 */
export class BriefService {
  /** The day being made, so two openers and the sweep share one making. */
  private making: { day: string; run: Promise<void> } | undefined;

  constructor(private readonly deps: BriefDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  list(input: BriefListInput = {}): Brief[] {
    return this.deps.repo.list(input.org, LIST_MAX);
  }

  /** Makes today's briefs when their hour has come and a workspace has none yet. Never throws. */
  async sweep(): Promise<void> {
    try {
      const clock = await this.deps.clock();
      const tz = ownerZone(clock.tz);
      const now = this.now();
      const day = localDay(now, tz);
      if (now.getTime() < briefDue(day, clock.at, tz).getTime()) return;
      if (this.making?.day === day) return this.making.run;
      const run = this.make(day).finally(() => {
        this.making = undefined;
      });
      this.making = { day, run };
      await run;
    } catch {
      // The next minute tries again; a brief that failed wrote nothing for its workspace, so nothing is half done.
    }
  }

  private async make(day: string): Promise<void> {
    const have = this.deps.repo.orgsOf(day);
    const orgs = (await this.deps.orgs()).filter((o) => !have.has(o.id));
    if (orgs.length === 0) return;
    const now = this.now();
    const last = this.deps.repo.lastBriefAt(day);
    const earliest = now.getTime() - SPAN_MAX_MS;
    const from = new Date(Math.max(last === undefined ? 0 : new Date(last).getTime(), earliest)).toISOString();
    const to = now.toISOString();
    const decisions = await this.deps.decisions();
    const findings = this.deps.findings().filter((f) => this.deps.briefHidden?.(f) !== true);
    const made: Brief[] = [];
    for (const org of orgs) {
      const facts = await this.facts(org, day, from, to, decisions, findings);
      const quiet = isQuiet(facts);
      // A quiet workspace costs no model call: its brief is never shown.
      const { lines, source } = await writeBrief(facts, quiet ? undefined : this.deps.write, this.deps.modelTimeoutMs);
      const brief: Brief = { org: org.id, day, at: to, lines, source, facts, quiet };
      // The primary key decides: if another process made it first, that one stands and nothing is said twice.
      if (this.deps.repo.add(brief)) made.push(brief);
    }
    if (made.length === 0) return;
    this.deps.changed?.();
    const told = made.filter((b) => !b.quiet);
    for (const b of told) await this.deps.chatLine?.(b.org, day, b.lines).catch(() => undefined);
    if (told.length > 0 && this.deps.repo.claimPush(day, to)) this.deps.tell?.(day, pushText(told));
  }

  /** Code gathers every fact of one workspace. Nothing here asks a model. */
  private async facts(
    org: { id: string; name: string },
    day: string,
    from: string,
    to: string,
    decisions: readonly OwnerDecision[],
    findings: readonly Finding[],
  ): Promise<BriefFacts> {
    const over = await this.deps.overnight(from, to, org.id);
    const mine = findings.filter((f) => (f.org ?? PRIVATE) === org.id);
    const waiting = decisions.filter((d) => (d.org ?? (d.task === undefined ? undefined : PRIVATE)) === org.id);
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    const within = (iso: string) => {
      const t = new Date(iso).getTime();
      return t >= fromMs && t < toMs;
    };
    return {
      org: org.id,
      orgName: org.name,
      day,
      from,
      to,
      took: over.took,
      shipped: over.shipped.length,
      shippedTitles: over.shipped.slice(0, 3).map((s) => oneLine(s.title, 80)),
      merged: over.merged,
      failed: over.failed,
      spent: over.spent,
      ...(over.budget === undefined ? {} : { budget: over.budget }),
      findingsNew: mine.filter((f) => within(f.createdAt)).length,
      findingsFixed: mine.filter((f) => f.status === "fixed" && within(f.updatedAt)).length,
      captainDecided: over.decided,
      captainUpkeep: over.upkeep,
      needs: { count: waiting.length, top: waiting.slice(0, 3).map((d) => oneLine(d.title, 80)) },
      next: this.deps.next(org.id, 3).map((t) => oneLine(t, 80)),
      empty: waiting.length === 0,
    };
  }
}
