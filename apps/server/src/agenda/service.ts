import {
  type AgendaToday,
  type AgendaTodayInput,
  type Brief,
  type BriefFacts,
  BUSINESS,
  type Deadline,
  type Finding,
  type Goal,
  type OwnerDecision,
  type VoiceProfile,
} from "@majhi/shared";
import { addDays, dayStart, localDay } from "../usage/ranges.ts";
import { minutesWord, oneLine, type Writer, writeBrief } from "./brief.ts";
import { type AgendaStep, buildItems, DEADLINE_DAYS, inScope, plan } from "./build.ts";
import type { Overnight } from "./overnight.ts";
import type { AgendaRepo } from "./repo.ts";
import { briefDue, daysBetween, ownerZone, whenWord } from "./time.ts";

/** The longest the overnight span reaches back: a server that was off for days still briefs about one night. */
const SPAN_MAX_MS = 36 * 3_600_000;
/** `agenda.today` waits this long for a brief that is being made before it answers without one. */
const WAIT_MS = 1_500;
/** The week the Plan section shows. */
const WEEK_DAYS = 7;
const RUNNING_MAX = 12;

export interface AgendaDeps {
  repo: AgendaRepo;
  /** The brief hour (`HH:MM`) and zone: the autonomy settings' `summary_at` and `tz`. */
  clock: () => Promise<{ at: string; tz?: string | undefined }>;
  decisions: (org?: string) => Promise<OwnerDecision[]>;
  /** Open deadlines due within this many days, overdue ones included. */
  deadlines: (withinDays: number) => Deadline[];
  /** Every finding, newest first (the agenda picks the live ones; the brief counts new and fixed). */
  findings: () => Finding[];
  /** A finding the owner does not want counted in the brief (its playbook's "tell me in the brief" is off). */
  briefHidden?: ((f: Finding) => boolean) | undefined;
  steps: () => AgendaStep[];
  goals: () => Goal[];
  running: () => { id: string; title: string; org?: string | undefined; since?: string | undefined }[];
  /** A workspace's name by id. */
  names: () => Promise<ReadonlyMap<string, string>>;
  overnight: (from: string, to: string) => Promise<Overnight & { spent: number; budget?: number }>;
  /** The owner's own voice profile, when one is written. */
  voice: () => VoiceProfile | undefined;
  /** The model that words the brief. Absent or failing: the template. */
  write?: Writer | undefined;
  /** The captain's queue titles, what it plans next. */
  next: (max: number) => string[];
  /** The scorecard's one line, when the scorecard exists. */
  scorecard?: (() => string | undefined) | undefined;
  /** Tells the owner the brief is ready: a desktop notification that opens Today. */
  notify?: (day: string, text: string) => void;
  changed?: () => void;
  now?: () => Date;
  /** How long the model gets. Tests shorten it. */
  modelTimeoutMs?: number;
}

/** The line a notification carries. It names what needs the owner, else what happened. */
export function notifyText(f: BriefFacts): string {
  const done = f.shipped > 0 ? `Shipped ${f.shipped} overnight. ` : "";
  if (f.empty) return `${done}Nothing needs you today.`.trim();
  return `${f.needs.count} ${f.needs.count === 1 ? "thing needs" : "things need"} you, ${minutesWord(f.needs.minutes)}. ${done}`.trim();
}

/** A brief with nothing in it (no work, no findings, nothing waiting) is stored but sends no notification. */
function worthTelling(f: BriefFacts): boolean {
  return !f.empty || f.shipped > 0 || f.failed > 0 || f.findingsNew > 0 || f.spent > 0;
}

export class AgendaService {
  /** The briefs being made, by day: two openers and the sweep share one. */
  private readonly making = new Map<string, Promise<Brief | undefined>>();

  constructor(private readonly deps: AgendaDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Today in the owner's zone, when the brief is due, and whether that moment has passed. */
  private async day(): Promise<{ day: string; tz: string; at: string; due: Date; passed: boolean }> {
    const clock = await this.deps.clock();
    const tz = ownerZone(clock.tz);
    const now = this.now();
    const day = localDay(now, tz);
    const due = briefDue(day, clock.at, tz);
    return { day, tz, at: clock.at, due, passed: now.getTime() >= due.getTime() };
  }

  /** The owner's review time per day. */
  budgetMinutes(): number {
    return this.deps.repo.budgetMinutes();
  }

  setBudgetMinutes(minutes: number): void {
    this.deps.repo.setBudgetMinutes(minutes);
    this.deps.changed?.();
  }

  /**
   * Today's brief, made once. Does nothing before the brief hour unless `force`, and nothing when today has
   * one. Two callers at once (a second tab, the sweep) share one making; a restart finds the stored row.
   */
  ensureBrief(force = false): Promise<Brief | undefined> {
    return this.briefFor(force);
  }

  private async briefFor(force: boolean): Promise<Brief | undefined> {
    const when = await this.day();
    // A row that exists but cannot be read still holds the day: it is not made again every minute.
    if (this.deps.repo.hasBrief(when.day)) return this.deps.repo.brief(when.day);
    if (!when.passed && !force) return undefined;
    const running = this.making.get(when.day);
    if (running !== undefined) return running;
    const made = this.make(when.day, when.tz).finally(() => this.making.delete(when.day));
    this.making.set(when.day, made);
    return made;
  }

  private async make(day: string, tz: string): Promise<Brief | undefined> {
    const now = this.now();
    const last = this.deps.repo.lastBriefAt(day);
    const earliest = now.getTime() - SPAN_MAX_MS;
    const from = new Date(
      Math.max(last === undefined ? 0 : new Date(last).getTime(), earliest),
    ).toISOString();
    const to = now.toISOString();
    const facts = await this.facts(day, tz, from, to);
    const { lines, source } = await writeBrief(
      facts,
      this.deps.voice(),
      this.deps.write,
      this.deps.modelTimeoutMs,
    );
    // The primary key decides: if another process made it first, that one stands and nothing is sent twice.
    if (!this.deps.repo.addBrief(day, to, source, lines, facts)) return this.deps.repo.brief(day);
    this.deps.changed?.();
    if (worthTelling(facts)) this.deps.notify?.(day, notifyText(facts));
    return this.deps.repo.brief(day);
  }

  /** Code gathers every fact. Nothing here asks a model. */
  private async facts(day: string, tz: string, from: string, to: string): Promise<BriefFacts> {
    const [over, names] = await Promise.all([this.deps.overnight(from, to), this.deps.names()]);
    const org = (o: string | undefined) => (o === undefined ? undefined : names.get(o));
    const { today, later } = this.planned(undefined, await this.deps.decisions(), tz, org);
    const all = [...today, ...later];
    const findings = this.deps.findings().filter((f) => this.deps.briefHidden?.(f) !== true);
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    const within = (iso: string) => {
      const t = new Date(iso).getTime();
      return t >= fromMs && t < toMs;
    };
    const dates = this.deps.deadlines(DEADLINE_DAYS).slice(0, 3);
    const now = this.now();
    const scorecard = this.deps.scorecard?.();
    return {
      day,
      from,
      to,
      shipped: over.shipped.length,
      shippedTitles: over.shipped.slice(0, 3).map((s) => oneLine(s.title, 80)),
      merged: over.merged,
      failed: over.failed,
      spent: over.spent,
      ...(over.budget === undefined ? {} : { budget: over.budget }),
      findingsNew: findings.filter((f) => within(f.createdAt)).length,
      findingsFixed: findings.filter((f) => f.status === "fixed" && within(f.updatedAt)).length,
      captainDecided: over.decided,
      captainUpkeep: over.upkeep,
      ...(scorecard === undefined ? {} : { scorecard }),
      needs: {
        count: all.length,
        minutes: all.reduce((n, i) => n + i.minutes, 0),
        top: today.slice(0, 3).map((i) => oneLine(i.title, 80)),
      },
      deadlines: dates.map((d) => ({
        title: oneLine(d.title, 80),
        when: whenWord(new Date(d.dueAt), now, tz),
      })),
      next: this.deps.next(3).map((t) => oneLine(t, 80)),
      empty: all.length === 0,
    };
  }

  /** The agenda cut at the review budget, from what the inputs say now. */
  private planned(
    scope: string | undefined,
    decisions: readonly OwnerDecision[],
    tz: string,
    orgName: (org: string | undefined) => string | undefined,
  ) {
    const items = buildItems({
      now: this.now(),
      tz,
      decisions,
      deadlines: inScope(this.deps.deadlines(DEADLINE_DAYS), scope),
      findings: inScope(
        this.deps.findings().filter((f) => f.status === "open"),
        scope,
      ),
      steps: inScope(this.deps.steps(), scope),
      orgName,
    });
    return plan(items, this.budgetMinutes());
  }

  /**
   * Everything the Today page shows, in one read. A brief that is due and missing starts being made.
   * `withBrief: false` leaves the brief out and makes none: it spans every workspace.
   */
  async today(input: AgendaTodayInput = {}, withBrief = true): Promise<AgendaToday> {
    const when = await this.day();
    const now = this.now();
    // The brief, if it is due and missing, starts now. A short wait lets a template or a quick model land in this read.
    let pending = false;
    let brief = withBrief ? this.deps.repo.brief(when.day) : undefined;
    if (withBrief && brief === undefined && when.passed && !this.deps.repo.hasBrief(when.day)) {
      const making = this.briefFor(false);
      let timer: NodeJS.Timeout | undefined;
      const slow = new Promise<"slow">((resolve) => {
        timer = setTimeout(() => resolve("slow"), WAIT_MS);
        timer.unref();
      });
      const got = await Promise.race([making.catch(() => undefined), slow]).finally(() =>
        clearTimeout(timer),
      );
      if (got === "slow") pending = true;
      else brief = got ?? undefined;
    }
    const names = await this.deps.names();
    const orgName = (o: string | undefined) => (o === undefined ? undefined : names.get(o));
    const scope = input.org;
    const decisions = await this.deps.decisions(scope);
    const planned = this.planned(scope, decisions, when.tz, orgName);
    const findings = inScope(this.deps.findings(), scope);
    const live = findings.filter((f) => ["open", "proposed", "task", "decision"].includes(f.status));
    const incidents = live
      .filter((f) => f.source === "incident" && f.severity !== "info")
      .map((f) => ({
        id: f.id,
        title: f.title,
        severity: f.severity,
        ...(f.org === undefined ? {} : { org: f.org }),
        ...(orgName(f.org) === undefined ? {} : { orgName: orgName(f.org) as string }),
        at: f.createdAt,
      }));
    const startOfDay = dayStart(when.day, when.tz).toISOString();
    const spend = await this.deps.overnight(startOfDay, now.toISOString());
    const weekEnd = addDays(when.day, WEEK_DAYS - 1);
    const dates = inScope(this.deps.deadlines(WEEK_DAYS + 1), scope)
      .filter((d) => localDay(new Date(d.dueAt), when.tz) <= weekEnd)
      .slice(0, 12);
    const goals = this.deps
      .goals()
      .filter((g) => g.status === "active" || g.status === "proposed")
      .filter((g) => scope === undefined || g.org === scope || g.org === BUSINESS);
    const dated = this.deps.deadlines(3650);
    return {
      day: when.day,
      tz: when.tz,
      at: now.toISOString(),
      budgetMinutes: this.budgetMinutes(),
      usedMinutes: planned.usedMinutes,
      over: planned.over,
      today: planned.today,
      later: planned.later,
      laterMinutes: planned.laterMinutes,
      ...(brief === undefined ? {} : { brief }),
      briefPending: pending,
      briefAt: when.at,
      watch: {
        running: scoped(this.deps.running(), scope)
          .slice(0, RUNNING_MAX)
          .map((t) => ({
            id: t.id,
            title: t.title,
            ...(t.org === undefined ? {} : { org: t.org }),
            ...(orgName(t.org) === undefined ? {} : { orgName: orgName(t.org) as string }),
            ...(t.since === undefined ? {} : { since: t.since }),
          })),
        incidents,
        spent: spend.spent,
        ...(spend.budget === undefined ? {} : { budget: spend.budget }),
      },
      plan: {
        deadlines: dates.map((d) => ({
          id: d.id,
          title: d.title,
          kind: d.kind,
          ...(d.org === undefined ? {} : { org: d.org }),
          ...(orgName(d.org) === undefined ? {} : { orgName: orgName(d.org) as string }),
          when: whenWord(new Date(d.dueAt), now, when.tz),
          dueAt: d.dueAt,
          daysLeft: daysBetween(when.day, localDay(new Date(d.dueAt), when.tz)),
        })),
        goals: goals.slice(0, 8).map((g) => ({
          id: g.id,
          title: g.title,
          org: g.org,
          ...(orgName(g.org) === undefined ? {} : { orgName: orgName(g.org) as string }),
          ...(g.target === undefined ? {} : { target: g.target }),
          ...(g.due === undefined ? {} : { due: g.due }),
          status: g.status,
          linked:
            findings.filter((f) => f.goal === g.id && f.status === "open").length +
            dated.filter((d) => d.goal === g.id).length,
        })),
        captainNext: this.deps.next(5),
      },
    };
  }

  dismissBrief(day: string): void {
    this.deps.repo.dismiss(day, this.now().toISOString());
    this.deps.changed?.();
  }

  /** The minute sweep: makes the brief when its hour has come. Never throws. */
  async sweep(): Promise<void> {
    try {
      await this.briefFor(false);
    } catch {
      // The next minute tries again; a failed brief writes nothing, so nothing is half done.
    }
  }
}

function scoped<T extends { org?: string | undefined }>(items: readonly T[], org: string | undefined): T[] {
  return org === undefined ? [...items] : items.filter((i) => i.org === org);
}
