import { createHash } from "node:crypto";
import {
  AUTHORITY_ROWS,
  type Authority,
  type AuthorityRow,
  type Cadence,
  type CaptainChore,
  ceilingDecisionId,
  isOutboundKey,
  type MoneySetInput,
  type MoneyStatus,
  moneyWord,
  OUTBOUND_CHANNEL_LABEL,
  OUTBOUND_CHANNELS,
  type OutboundChannel,
  type OutboundMode,
  type OwnerDecision,
  outboundKey,
  PRIVATE,
  type Scorecard,
  type ScorecardPlaybook,
  type ScorecardRange,
  type ScorecardRow,
  scorecardLine,
  TRUST_QUIET_DAYS,
  TRUST_SNOOZE_DAYS,
  TRUST_WINDOW_DEFAULT,
  type TrustList,
  trustDecisionId,
} from "@majhi/shared";
import { didWords, didWordsInline, OWNER } from "@majhi/shared";
import type Database from "better-sqlite3";
import { UserError } from "../errors.ts";
import { addDays, dayStart, localDay, weekStart } from "../usage/ranges.ts";
import { deriveAll, KEEP_AFTER_MS } from "./derive.ts";
import { percent, shouldMute, shouldPropose, windowOf } from "./ladder.ts";
import { monthLine, monthWindow, projectedSpend, raisedCeiling } from "./money.ts";
import { type Derived, type OutcomeRow, OutcomesRepo, type TrustNotice } from "./repo.ts";
import { choreTokens, laneSpend, monthSpend, playbookRuns, playbookTokens, startedSpend } from "./spend.ts";
import { findingsTally, tallyOf, ZERO_TALLY } from "./tally.ts";

/**
 * Outcomes, the scorecard, the trust ladder and the one monthly ceiling (SPEC 5.18, captain v2 step 8).
 * A pass reads every captain output with its judgment now (derive.ts), keeps it joined to its
 * workspace, authority row, playbook and task, and then runs the ladder: when the owner undoes or
 * reverses an output the captain made on a row, that row drops to You (a channel to Draft) and the
 * owner is told in Decisions; above 95 percent kept it only proposes; a playbook whose findings are
 * mostly dismissed is muted to a weekly schedule and one click undoes it. A line moves down only
 * when the owner took something back, and up only on the owner's word.
 */

const WEEKLY: Cadence = { kind: "weekly", day: 1, at: "08:00" };

const ROW_NAME: Record<AuthorityRow, string> = {
  start: "Start work",
  questions: "Answer questions",
  approvals: "Routine approvals",
  upkeep: "Upkeep",
  merge: "Merge",
  push: "Push",
  deployStaging: "Deploy to staging",
  deployProduction: "Deploy to production",
  tell: "Client replies",
  own: "Own work",
};

/** What the owner did, for the line that says why a line dropped. */
const TAKEN_BACK = {
  undone: didWordsInline(OWNER, "undid"),
  reverted: didWordsInline(OWNER, "reverted"),
  "merged-reverted": didWordsInline(OWNER, "reverted"),
  rejected: didWordsInline(OWNER, "rejected"),
  overruled: didWordsInline(OWNER, "overruled"),
} as const;

const MODE_NAME: Record<OutboundMode, string> = { draft: "Draft", batch: "Batch", auto: "Auto" };

export interface OutcomesDeps {
  db: Database.Database;
  now?: () => Date;
  /** The owner's time zone, for days, weeks and months. */
  tz: () => Promise<string>;
  /** Workspaces the captain knows. */
  orgs: () => Promise<string[]>;
  orgName: (org: string) => Promise<string>;
  playbookOfChore?: (chore: CaptainChore) => string | undefined;
  /** What each authority row is set to now. */
  authority: (org: string) => Promise<Authority>;
  setAuthority: (org: string, row: AuthorityRow, choice: "decide" | "ask", reason: string) => Promise<void>;
  outbound: {
    mode(org: string, channel: OutboundChannel): OutboundMode;
    /** Moves a channel by the ladder: the one way past the owner's explicit Auto. */
    applyLadder(org: string, channel: OutboundChannel, mode: OutboundMode): void;
  };
  playbooks: {
    name(id: string): string;
    state(org: string, id: string): { cadence: Cadence; enabled: boolean } | undefined;
    setCadence(org: string, id: string, cadence: Cadence): Promise<void>;
  };
  /** The judged outputs the ladder reads (default 20). */
  window?: number;
  keepAfterMs?: number;
  changed?: () => void;
}

/** A hash of what a pass derived (not when it ran), to tell whether the next pass found anything new. */
function derivedMarker(derived: readonly Derived[]): string {
  const hash = createHash("sha1");
  for (const d of derived)
    hash.update(
      `${d.subject}|${d.kind}|${d.org}|${d.key ?? ""}|${d.playbook ?? ""}|${d.task ?? ""}|${d.at}|${d.result ?? ""}\n`,
    );
  return hash.digest("hex");
}

/** The newest facts the money gate reads, kept a few seconds so a gate checked on every wake stays cheap. */
const MONEY_TTL_MS = 15_000;

export class OutcomesService {
  readonly repo: OutcomesRepo;
  private queue: Promise<unknown> = Promise.resolve();
  private lastSweep = 0;
  /** What the last pass derived, as a hash: a pass that derives the same writes nothing. */
  private lastMarker: string | undefined;
  private tzCache = "UTC";
  private moneyCache: { at: number; spent: number; month: string } | undefined;

  constructor(private readonly deps: OutcomesDeps) {
    this.repo = new OutcomesRepo(deps.db);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
  private iso(): string {
    return this.now().toISOString();
  }
  /** How many judged outputs the ladder reads: the owner's setting, else the default of 20. */
  get window(): number {
    const set = Number(this.repo.moneyValue("trust_window"));
    return Number.isInteger(set) && set >= 3 ? set : (this.deps.window ?? TRUST_WINDOW_DEFAULT);
  }

  setWindow(n: number | undefined): number {
    this.repo.setMoneyValue("trust_window", n === undefined ? undefined : String(n));
    this.deps.changed?.();
    return this.window;
  }

  // ---------------------------------------------------------------------------
  // The pass

  /** One pass at a time: derive, store, run the ladder. */
  sweep(): Promise<void> {
    const next = this.queue.then(() => this.pass());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async pass(): Promise<void> {
    this.tzCache = await this.deps.tz();
    const now = this.now();
    const derived = deriveAll(this.deps.db, {
      now,
      keepAfterMs: this.deps.keepAfterMs ?? KEEP_AFTER_MS,
      ...(this.deps.playbookOfChore === undefined ? {} : { playbookOfChore: this.deps.playbookOfChore }),
    });
    const at = now.toISOString();
    const marker = derivedMarker(derived);
    this.lastSweep = now.getTime();
    // Derived the same as last pass: nothing to write and nothing for the UI to refetch. Otherwise only
    // the rows that differ are written. The ladder always runs: it also reads the owner's settings and
    // the clock, and the notices it writes announce themselves.
    let written = 0;
    if (marker !== this.lastMarker) {
      written = this.repo.upsertChanged(derived, at);
      this.lastMarker = marker;
    }
    await this.runLadder(now);
    if (written > 0) this.deps.changed?.();
  }

  /** A sweep for a read, unless one ran in the last minute. */
  private async fresh(): Promise<void> {
    if (this.now().getTime() - this.lastSweep > 60_000) await this.sweep();
    else await this.queue;
  }

  /** The owner answered a decision the captain had an opinion on: it agreed or it did not. */
  answered(
    decision: Pick<OwnerDecision, "id" | "kind" | "org" | "task" | "suggestion">,
    option: string,
  ): void {
    const s = decision.suggestion;
    if (s === undefined || s.by !== "captain") return;
    const key =
      decision.kind === "ship"
        ? "merge"
        : decision.kind === "approval"
          ? "approvals"
          : decision.kind === "question"
            ? "questions"
            : undefined;
    if (key === undefined) return;
    const at = this.iso();
    const d: Derived = {
      subject: `rec:${decision.id}`,
      kind: "recommendation",
      org: decision.org ?? PRIVATE,
      key,
      ...(decision.task === undefined ? {} : { task: decision.task }),
      at,
      result: option === s.option ? "accepted" : "overruled",
    };
    this.repo.record(d, at);
    this.deps.changed?.();
  }

  // ---------------------------------------------------------------------------
  // The ladder

  private async runLadder(now: Date): Promise<void> {
    for (const org of await this.deps.orgs()) {
      const auth = await this.deps.authority(org);
      for (const row of AUTHORITY_ROWS) {
        await this.rung(org, row, auth[row] === "decide" ? "decide" : "ask", now).catch(() => undefined);
      }
      for (const channel of OUTBOUND_CHANNELS) {
        await this.rung(org, outboundKey(channel), this.deps.outbound.mode(org, channel), now).catch(
          () => undefined,
        );
      }
    }
    await this.mutes(now).catch(() => undefined);
  }

  /** The step up from a setting, for the proposal. Auto is the top. */
  private stepUp(key: string, setting: string): string | undefined {
    if (isOutboundKey(key)) return setting === "draft" ? "batch" : setting === "batch" ? "auto" : undefined;
    return setting === "ask" ? "decide" : undefined;
  }

  private canDrop(key: string, setting: string): boolean {
    return isOutboundKey(key) ? setting === "batch" || setting === "auto" : setting === "decide";
  }

  private async rung(org: string, key: string, setting: string, now: Date): Promise<void> {
    const n = this.window;
    const t = this.repo.trust(org, key);
    const rows = this.repo.judgedForKey(org, key, t.since, n);
    const back = this.repo.takenBackSince(org, key, t.since);
    if (this.canDrop(key, setting) && back !== undefined) {
      await this.demote(org, key, setting, back, now);
      return;
    }
    const up = this.stepUp(key, setting);
    const open = this.repo.openNotices().find((x) => x.org === org && x.key === key && x.kind === "promote");
    if (up === undefined) return;
    const recent = this.repo.overruledSince(
      org,
      key,
      new Date(now.getTime() - TRUST_QUIET_DAYS * 86_400_000).toISOString(),
    );
    const proposes = shouldPropose(rows.slice(0, n), n, recent);
    if (open !== undefined) {
      // The record changed under an open proposal: withdraw it.
      if (!proposes) {
        this.repo.closeNotice(open.id, "dismissed", now.toISOString());
        this.deps.changed?.();
      }
      return;
    }
    if (!proposes) return;
    if (t.snoozedUntil !== undefined && t.snoozedUntil > now.toISOString()) return;
    const w = windowOf(rows.slice(0, n));
    const name = await this.deps.orgName(org);
    this.repo.addNotice({
      org,
      key,
      kind: "promote",
      text: this.promoteText(name, key, up, w.kept, w.judged),
      evidence: `${w.kept} of the last ${w.judged} kept, nothing taken back in ${TRUST_QUIET_DAYS} days.`,
      data: { from: setting, to: up },
      at: now.toISOString(),
    });
    this.deps.changed?.();
  }

  private promoteText(name: string, key: string, up: string, kept: number, judged: number): string {
    if (isOutboundKey(key)) {
      const ch = OUTBOUND_CHANNEL_LABEL[key.slice("outbound:".length) as OutboundChannel];
      return `${name}: ${ch} drafts went out as written, ${kept} of ${judged}. Move ${ch} to ${MODE_NAME[up as OutboundMode]}?`;
    }
    return `${name}: ${ROW_NAME[key as AuthorityRow]} has run clean, ${kept} of ${judged} kept. Let the captain decide it?`;
  }

  private async demote(
    org: string,
    key: string,
    setting: string,
    back: OutcomeRow,
    now: Date,
  ): Promise<void> {
    const at = now.toISOString();
    const name = await this.deps.orgName(org);
    const was = this.describe(back);
    const what = `${TAKEN_BACK[back.result as keyof typeof TAKEN_BACK] ?? didWordsInline(OWNER, "took back")} "${was.endsWith(".") ? was.slice(0, -1) : was}"`;
    if (isOutboundKey(key)) {
      const channel = key.slice("outbound:".length) as OutboundChannel;
      this.deps.outbound.applyLadder(org, channel, "draft");
      this.repo.setTrust(org, key, { since: at, autoOk: false });
      this.repo.addNotice({
        org,
        key,
        kind: "demoted",
        text: `${OUTBOUND_CHANNEL_LABEL[channel]} is back to Draft in ${name}: ${what}.`,
        evidence: "Give it back to let it send by itself again.",
        data: { from: setting, to: "draft" },
        at,
      });
    } else {
      const row = key as AuthorityRow;
      await this.deps.setAuthority(org, row, "ask", `Trust ladder: ${what}`);
      this.repo.setTrust(org, key, { since: at });
      this.repo.addNotice({
        org,
        key,
        kind: "demoted",
        text: `${ROW_NAME[row]} is back to You in ${name}: ${what}.`,
        evidence: "Give it back to let the captain do it again.",
        data: { from: setting, to: "ask" },
        at,
      });
    }
    this.deps.changed?.();
  }

  private describe(r: OutcomeRow): string {
    const { db } = this.deps;
    if (r.action !== undefined) {
      const a = db.prepare("SELECT text FROM captain_actions WHERE id = ?").get(r.action) as
        | { text: string }
        | undefined;
      if (a !== undefined) return a.text.slice(0, 90);
    }
    if (r.kind === "draft") {
      const id = Number(r.subject.slice("draft:".length));
      const d = db.prepare("SELECT channel, target FROM outbound_drafts WHERE id = ?").get(id) as
        | { channel: string; target: string }
        | undefined;
      if (d !== undefined)
        return `${OUTBOUND_CHANNEL_LABEL[d.channel as OutboundChannel] ?? d.channel} to ${d.target}`;
    }
    if (r.task !== undefined) {
      const t = db.prepare("SELECT title FROM tasks WHERE id = ?").get(r.task) as
        | { title: string }
        | undefined;
      return t === undefined ? `Task ${r.task}` : `${r.task}: ${t.title}`.slice(0, 90);
    }
    return r.subject;
  }

  private async mutes(now: Date): Promise<void> {
    const n = this.window;
    // A mute nobody answered yet whose record no longer holds (its dismissals turned out to be majhi's
    // own folds, not judgments) is lifted by majhi itself.
    for (const notice of this.repo.openNotices()) {
      if (notice.kind !== "muted") continue;
      const playbook = String(notice.data.playbook ?? "");
      const before = this.repo.judgedFindings(notice.org, playbook, undefined, n);
      if (shouldMute(before, n)) continue;
      await this.unmute(notice.org, playbook, notice).catch(() => undefined);
    }
    for (const { org, playbook } of this.repo.playbooks()) {
      const key = `playbook:${playbook}`;
      const t = this.repo.trust(org, key);
      const rows = this.repo.judgedFindings(org, playbook, t.since, n);
      if (!shouldMute(rows, n)) continue;
      const state = this.deps.playbooks.state(org, playbook);
      if (state === undefined || !state.enabled) continue;
      if (state.cadence.kind === "weekly" || state.cadence.kind === "manual") continue;
      const at = now.toISOString();
      const dismissed = rows.slice(0, n).filter((r) => r.result === "dismissed").length;
      await this.deps.playbooks.setCadence(org, playbook, WEEKLY);
      this.repo.setTrust(org, key, { since: at });
      const name = await this.deps.orgName(org);
      this.repo.addNotice({
        org,
        key,
        kind: "muted",
        text: `${name}: ${this.deps.playbooks.name(playbook)} now runs weekly. ${dismissed} of its last ${Math.min(n, rows.length)} findings were dismissed.`,
        evidence: `It ran ${state.cadence.kind === "daily" ? "daily" : "on its own schedule"} before. Undo puts that back.`,
        data: { playbook, previous: state.cadence },
        at,
      });
      this.deps.changed?.();
    }
  }

  // ---------------------------------------------------------------------------
  // The owner answers

  /** Notices as Decisions, plus the money question when the ceiling is reached. */
  decisions(): OwnerDecision[] {
    const out: OwnerDecision[] = [];
    for (const n of this.repo.openNotices()) {
      if (n.kind === "muted") {
        // Muting tells the owner and needs no answer; it stays until read or undone.
        out.push(
          this.noticeDecision(n, [
            { id: "undo", label: "Undo", primary: true },
            { id: "ok", label: "Got it" },
          ]),
        );
      } else if (n.kind === "demoted") {
        out.push(
          this.noticeDecision(n, [
            { id: "ok", label: "Got it", primary: true },
            { id: "restore", label: "Give it back" },
          ]),
        );
      } else {
        const to = typeof n.data.to === "string" ? n.data.to : "";
        out.push(
          this.noticeDecision(n, [
            {
              id: "promote",
              label: to === "decide" ? "Let it decide" : `Move to ${MODE_NAME[to as OutboundMode] ?? to}`,
              primary: true,
            },
            { id: "later", label: "Not now" },
          ]),
        );
      }
    }
    const ceiling = this.ceilingDecision();
    if (ceiling !== undefined) out.push(ceiling);
    return out;
  }

  private noticeDecision(n: TrustNotice, options: OwnerDecision["options"]): OwnerDecision {
    return {
      id: trustDecisionId(n.id),
      kind: "trust",
      ...(n.org === PRIVATE ? {} : { org: n.org }),
      title: n.text.slice(0, 300),
      sentence: `${n.text} ${n.evidence}`.slice(0, 500),
      options,
      at: n.at,
      link: { kind: "captain" },
    };
  }

  async answerNotice(id: number, option: string): Promise<void> {
    const n = this.repo.notice(id);
    if (n === undefined || n.state !== "open") {
      throw new UserError("That decision is gone: it was answered already.", 409);
    }
    const at = this.iso();
    const to = typeof n.data.to === "string" ? n.data.to : undefined;
    const from = typeof n.data.from === "string" ? n.data.from : undefined;
    if (n.kind === "muted") {
      if (option === "undo") await this.unmute(n.org, String(n.data.playbook ?? ""), n);
      else this.repo.closeNotice(n.id, "accepted", at);
    } else if (n.kind === "demoted") {
      if (option === "restore" && from !== undefined) {
        await this.apply(n.org, n.key, from, didWords(OWNER, "gave it back after a demotion"));
        this.repo.setTrust(n.org, n.key, { since: at });
        this.repo.closeNotice(n.id, "undone", at);
      } else {
        this.repo.closeNotice(n.id, "accepted", at);
      }
    } else if (option === "promote" && to !== undefined) {
      await this.apply(n.org, n.key, to, didWords(OWNER, "accepted the captain's proposal"));
      this.repo.setTrust(n.org, n.key, {
        since: at,
        ...(to === "auto" ? { autoOk: true } : {}),
      });
      this.repo.closeNotice(n.id, "accepted", at);
    } else {
      const until = new Date(this.now().getTime() + TRUST_SNOOZE_DAYS * 86_400_000).toISOString();
      this.repo.setTrust(n.org, n.key, { snoozedUntil: until });
      this.repo.closeNotice(n.id, "dismissed", at);
    }
    this.deps.changed?.();
  }

  /** Puts a row or channel at a setting, by the owner's word. */
  private async apply(org: string, key: string, to: string, reason: string): Promise<void> {
    if (isOutboundKey(key)) {
      this.deps.outbound.applyLadder(
        org,
        key.slice("outbound:".length) as OutboundChannel,
        to as OutboundMode,
      );
    } else {
      await this.deps.setAuthority(org, key as AuthorityRow, to === "decide" ? "decide" : "ask", reason);
    }
  }

  /** Whether the owner accepted Auto for a channel: the only way it becomes selectable. */
  autoAccepted(org: string, channel: OutboundChannel): boolean {
    return this.repo.trust(org, outboundKey(channel)).autoOk;
  }

  async unmute(org: string, playbook: string, notice?: TrustNotice): Promise<void> {
    const found = notice ?? this.repo.mutedNotices(org).find((n) => n.data.playbook === playbook);
    if (found === undefined) throw new UserError(`${playbook} is not muted in ${org}.`, 404);
    const previous = found.data.previous as Cadence | undefined;
    if (previous === undefined) throw new UserError("Nothing to put back.", 409);
    await this.deps.playbooks.setCadence(org, playbook, previous);
    const at = this.iso();
    // The record before the mute no longer counts: a muted playbook that comes back starts clean.
    this.repo.setTrust(org, `playbook:${playbook}`, { since: at });
    this.repo.closeNotice(found.id, "undone", at);
    this.deps.changed?.();
  }

  /** The ladder's state for the workspaces asked, one entry per authority row and channel. */
  async trust(org?: string): Promise<TrustList> {
    await this.fresh();
    const targets = org === undefined ? await this.deps.orgs() : [org];
    const states: TrustList["states"] = [];
    for (const o of targets) {
      const auth = await this.deps.authority(o);
      const entries: [string, string][] = [
        ...AUTHORITY_ROWS.map((r) => [r, auth[r] === "decide" ? "decide" : "ask"] as [string, string]),
        ...OUTBOUND_CHANNELS.map((c) => [outboundKey(c), this.deps.outbound.mode(o, c)] as [string, string]),
      ];
      for (const [key, now] of entries) {
        const t = this.repo.trust(o, key);
        const rows = this.repo.judgedForKey(o, key, t.since, this.window);
        states.push({
          org: o,
          key,
          now,
          ...(t.since === undefined ? {} : { since: t.since }),
          ...(t.snoozedUntil === undefined ? {} : { snoozedUntil: t.snoozedUntil }),
          window: windowOf(rows),
        });
      }
    }
    return {
      window: this.window,
      states,
      muted: this.repo
        .mutedNotices(org)
        .map((n) => ({ org: n.org, playbook: String(n.data.playbook ?? ""), at: n.at })),
    };
  }

  // ---------------------------------------------------------------------------
  // The scorecard

  private async span(range: ScorecardRange): Promise<{ from: string; to: string }> {
    const tz = await this.deps.tz();
    const today = localDay(this.now(), tz);
    const first = range === "today" ? today : weekStart(today);
    return {
      from: dayStart(first, tz).toISOString(),
      to: dayStart(addDays(today, 1), tz).toISOString(),
    };
  }

  async scorecard(range: ScorecardRange, only?: string): Promise<Scorecard> {
    await this.fresh();
    const { from, to } = await this.span(range);
    const { db } = this.deps;
    const minutes = this.repo.minutes();
    const all = this.repo.between(from, to, only);
    const known = new Set(only === undefined ? await this.deps.orgs() : [only]);
    const byOrg = new Map<string, OutcomeRow[]>();
    for (const r of all) byOrg.set(r.org, [...(byOrg.get(r.org) ?? []), r]);
    for (const o of known) if (!byOrg.has(o)) byOrg.set(o, []);

    const orgs: Scorecard["orgs"] = [];
    const rows: ScorecardRow[] = [];
    const playbooks: ScorecardPlaybook[] = [];
    let totalTokens = 0;
    let totalCost = 0;
    const muted = new Set(this.repo.mutedNotices(only).map((n) => `${n.org}\u0000${n.data.playbook}`));
    for (const [org, list] of byOrg) {
      const lane = laneSpend(db, org, from, to);
      const started = startedSpend(db, org, from, to);
      const spend = { tokens: lane.tokens + started.tokens, costUsd: lane.costUsd + started.costUsd };
      totalTokens += spend.tokens;
      totalCost += spend.costUsd;
      const findings = findingsTally(list);
      const tally = tallyOf(list, minutes, spend);
      const saved = Math.round((tally.minutesSaved + findings.accepted * (minutes.finding ?? 0)) * 10) / 10;
      const withFindings = { ...tally, minutesSaved: saved };
      const line = scorecardLine(withFindings);
      if (line === undefined && list.length === 0) continue;
      orgs.push({ org, tally: withFindings, findings, ...(line === undefined ? {} : { line }) });

      // Dollars per token the lane paid, to price a slice that only has tokens.
      const ratio = lane.tokens > 0 ? lane.costUsd / lane.tokens : 0;
      const rowTokens = new Map<string, number>();
      for (const [chore, tokens] of choreTokens(db, org, from, to)) {
        const row =
          chore === "ship"
            ? "merge"
            : chore === "cards"
              ? "approvals"
              : chore === "questions"
                ? "questions"
                : "upkeep";
        rowTokens.set(row, (rowTokens.get(row) ?? 0) + tokens);
      }
      const keys = new Set(list.flatMap((r) => (r.key === undefined ? [] : [r.key])));
      for (const key of keys) {
        const slice = list.filter((r) => r.key === key);
        const tokens = rowTokens.get(key) ?? 0;
        const t = this.repo.trust(org, key);
        const w = windowOf(this.repo.judgedForKey(org, key, t.since, this.window));
        const last = this.repo.lastNotice(org, key, "demoted");
        const note =
          last !== undefined && last.state !== "undone" && (t.since === undefined || last.at >= t.since)
            ? "Dropped to You by the trust ladder"
            : undefined;
        rows.push({
          org,
          key,
          tally: tallyOf(slice, minutes, { tokens, costUsd: tokens * ratio }),
          window: w,
          ...(note === undefined ? {} : { note }),
        });
      }
      const pbIds = new Set(list.flatMap((r) => (r.playbook === undefined ? [] : [r.playbook])));
      const pbTokens = playbookTokens(db, org, from, to);
      for (const [pb, tokens] of pbTokens) if (tokens > 0) pbIds.add(pb);
      for (const pb of pbIds) {
        const slice = list.filter((r) => r.playbook === pb);
        const tokens = pbTokens.get(pb) ?? 0;
        const t = tallyOf(slice, minutes, { tokens, costUsd: tokens * ratio });
        playbooks.push({
          org,
          playbook: pb,
          tally: t,
          findings: findingsTally(slice),
          muted: muted.has(`${org}\u0000${pb}`),
          runs: playbookRuns(db, org, pb, from, to),
        });
      }
    }
    const total = tallyOf(all, minutes, { tokens: totalTokens, costUsd: totalCost });
    const findingMinutes = orgs.reduce((n, o) => n + o.findings.accepted * (minutes.finding ?? 0), 0);
    return {
      range,
      from,
      to,
      total:
        all.length === 0 && totalCost === 0
          ? { ...ZERO_TALLY }
          : { ...total, minutesSaved: Math.round((total.minutesSaved + findingMinutes) * 10) / 10 },
      orgs: orgs.toSorted((a, b) => b.tally.actions - a.tally.actions || a.org.localeCompare(b.org)),
      rows,
      playbooks,
      minutes,
      window: this.window,
    };
  }

  setMinutes(kind: string, minutes: number | undefined): Record<string, number> {
    this.repo.setMinutes(kind, minutes);
    this.deps.changed?.();
    return this.repo.minutes();
  }

  // ---------------------------------------------------------------------------
  // Money: one ceiling across all spend

  private spent(now: Date): {
    spent: number;
    month: string;
    from: string;
    to: string;
    tokens: number;
    byOrg: Map<string, { tokens: number; costUsd: number }>;
  } {
    const w = monthWindow(now, this.tzCache);
    const byOrg = monthSpend(this.deps.db, w.from, w.to);
    let spent = 0;
    let tokens = 0;
    for (const s of byOrg.values()) {
      spent += s.costUsd;
      tokens += s.tokens;
    }
    spent = Math.round(spent * 100) / 100;
    this.moneyCache = { at: now.getTime(), spent, month: w.month };
    return { spent, month: w.month, from: w.from, to: w.to, tokens, byOrg };
  }

  private savedCeiling(): number | undefined {
    const raw = this.repo.moneyValue("ceiling_usd");
    const n = raw === undefined ? undefined : Number(raw);
    return n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
  }

  /** The ceiling as it holds this month: the saved one, or the owner's raise for the month when higher. */
  private ceilingFor(month: string): number | undefined {
    const saved = this.savedCeiling();
    const raised = Number(this.repo.moneyValue(`raise:${month}`));
    if (saved === undefined) return undefined;
    return Number.isFinite(raised) && raised > saved ? raised : saved;
  }

  private cachedSpent(): { spent: number; month: string } {
    const now = this.now();
    const c = this.moneyCache;
    const month = monthWindow(now, this.tzCache).month;
    if (c !== undefined && c.month === month && now.getTime() - c.at < MONEY_TTL_MS) return c;
    const s = this.spent(now);
    return { spent: s.spent, month: s.month };
  }

  /**
   * Why new starts are held now, or undefined. Read at the moment something would start (a captain wake,
   * a chore, a playbook, a task the captain picks); a turn that is running is never stopped by it.
   */
  ceilingHeld(): string | undefined {
    const { spent, month } = this.cachedSpent();
    const ceiling = this.ceilingFor(month);
    if (ceiling === undefined || spent < ceiling) return undefined;
    return `the monthly ceiling of ${moneyWord(ceiling)} is reached (${moneyWord(spent)} spent this month)`;
  }

  async money(): Promise<MoneyStatus> {
    this.tzCache = await this.deps.tz();
    const now = this.now();
    const w = monthWindow(now, this.tzCache);
    const s = this.spent(now);
    const ceiling = this.ceilingFor(w.month);
    const projected = projectedSpend(s.spent, w);
    const rates = this.repo.rates();
    const minutes = this.repo.minutes();
    const rows = this.repo.between(w.from, w.to);
    const names = new Set<string>([...s.byOrg.keys(), ...rates.keys(), ...rows.map((r) => r.org)]);
    const orgs: MoneyStatus["orgs"] = [];
    let captain = 0;
    for (const org of [...names].sort()) {
      const spend = s.byOrg.get(org) ?? { tokens: 0, costUsd: 0 };
      const mine = rows.filter((r) => r.org === org);
      const t = tallyOf(mine, minutes);
      const accepted = mine.filter((r) => r.kind === "finding" && r.result === "accepted").length;
      const mins = t.minutesSaved + accepted * (minutes.finding ?? 0);
      const r = rates.get(org) ?? {};
      captain += laneSpend(this.deps.db, org, w.from, w.to).costUsd;
      orgs.push({
        org,
        spentUsd: Math.round(spend.costUsd * 100) / 100,
        tokens: spend.tokens,
        minutesSaved: Math.round(mins * 10) / 10,
        rates: r,
        ...(r.hourlyUsd === undefined ? {} : { savedUsd: Math.round((mins / 60) * r.hourlyUsd * 100) / 100 }),
        ...(r.retainerUsd === undefined
          ? {}
          : { marginUsd: Math.round((r.retainerUsd - spend.costUsd) * 100) / 100 }),
      });
    }
    const saved = this.savedCeiling();
    const held = ceiling !== undefined && s.spent >= ceiling;
    return {
      month: w.month,
      from: w.from,
      to: w.to,
      spentUsd: s.spent,
      tokens: s.tokens,
      ...(ceiling === undefined ? {} : { ceilingUsd: ceiling }),
      ...(saved === undefined ? {} : { savedCeilingUsd: saved }),
      ...(projected === undefined ? {} : { projectedUsd: projected }),
      held,
      line: monthLine(s.spent, ceiling, projected),
      orgs,
      parts: {
        agents: Math.max(0, Math.round((s.spent - captain) * 100) / 100),
        captain: Math.round(captain * 100) / 100,
      },
    };
  }

  async setMoney(input: MoneySetInput): Promise<MoneyStatus> {
    if (input.ceilingUsd !== undefined) {
      this.repo.setMoneyValue(
        "ceiling_usd",
        input.ceilingUsd === null ? undefined : String(input.ceilingUsd),
      );
      this.moneyCache = undefined;
    }
    if (input.rates !== undefined) {
      this.repo.setRates(input.rates.org, {
        ...(input.rates.retainerUsd === undefined ? {} : { retainerUsd: input.rates.retainerUsd }),
        ...(input.rates.hourlyUsd === undefined ? {} : { hourlyUsd: input.rates.hourlyUsd }),
      });
    }
    this.deps.changed?.();
    return this.money();
  }

  /** The Money decision: shown once the ceiling is reached, until the owner raises it or leaves it for the month. */
  private ceilingDecision(): OwnerDecision | undefined {
    const { spent, month } = this.cachedSpent();
    const ceiling = this.ceilingFor(month);
    if (ceiling === undefined || spent < ceiling) return undefined;
    if (this.repo.moneyValue(`left:${month}`) !== undefined) return undefined;
    const raiseTo = raisedCeiling(ceiling);
    const at = this.repo.moneyValue(`reached:${month}`) ?? this.stampReached(month);
    return {
      id: ceilingDecisionId(month),
      kind: "budget",
      title: `Monthly ceiling reached: ${moneyWord(spent)} of ${moneyWord(ceiling)}`,
      sentence: `majhi spent ${moneyWord(spent)} of your ${moneyWord(ceiling)} ceiling for ${month}. New starts by the captain are held. Work that is running continues. Raise the ceiling for this month, or leave it and nothing new starts until the month ends.`,
      options: [
        { id: "raise", label: `Raise to ${moneyWord(raiseTo)} this month`, primary: true },
        { id: "leave", label: "Keep the ceiling" },
      ],
      at,
      link: { kind: "limits" },
    };
  }

  private stampReached(month: string): string {
    const at = this.iso();
    this.repo.setMoneyValue(`reached:${month}`, at);
    return at;
  }

  async answerCeiling(month: string, option: string): Promise<void> {
    const w = monthWindow(this.now(), this.tzCache);
    if (month !== w.month) throw new UserError("That decision is gone: the month ended.", 409);
    const ceiling = this.ceilingFor(month);
    if (ceiling === undefined) throw new UserError("That decision is gone: there is no ceiling.", 409);
    if (option === "raise") this.repo.setMoneyValue(`raise:${month}`, String(raisedCeiling(ceiling)));
    else this.repo.setMoneyValue(`left:${month}`, this.iso());
    this.moneyCache = undefined;
    this.deps.changed?.();
  }
}
