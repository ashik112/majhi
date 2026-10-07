import {
  AUTO_DAILY_LIMIT,
  type Draft,
  DraftSchema,
  type DraftStatus,
  detectSecrets,
  OUTBOUND_CHANNELS,
  type OutboundChannel,
  OutboundChannelSchema,
  type OutboundChannelState,
  type OutboundMode,
  type OutboundSetModeInput,
  type OutboundSubmitInput,
  onceInstant,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import { errorMessage, UserError } from "../errors.ts";
import { addDays, localDay } from "../usage/ranges.ts";

/**
 * The outbound gate (SPEC 5.18, "One gate for every output that leaves the machine"). Whatever would
 * leave it, an email, a post, a comment on a public tracker, a form, a message, is offered here and
 * nowhere else. The channel's mode decides the path: Draft waits for the owner's approval, Batch waits
 * for an approved batch, Auto sends within a daily limit and only where the owner set it on purpose.
 * `release` is the single place a transport is called, and only the owner's decision or Auto reaches it.
 */

/** Carries an approved draft out. None is connected yet: a channel gets one with its connection. */
export interface OutboundTransport {
  send(draft: Draft): Promise<{ ok: boolean; detail: string }>;
}

export type GateActor =
  | { kind: "owner" }
  | { kind: "captain"; org?: string | undefined }
  | { kind: "agent"; id: string; org: string };

export interface OutboundDeps {
  db: Database.Database;
  now?: () => Date;
  /** The workspace's time zone. */
  tz: (org: string) => Promise<string>;
  /** Whether a workspace exists. */
  knownOrg: (org: string) => Promise<boolean>;
  transports?: Partial<Record<OutboundChannel, OutboundTransport>>;
  /** Whether the owner accepted a promotion to Auto for this channel (the trust ladder). Without it Auto is never selectable. */
  autoAllowed?: (org: string, channel: OutboundChannel) => boolean;
  changed?: () => void;
  /** A draft reached an end (sent, failed, discarded) or its text changed: whoever shows it keeps up. */
  settled?: (draft: Draft) => void;
}

interface DraftRow {
  id: number;
  org: string;
  channel: string;
  target: string;
  subject: string | null;
  body: string;
  voice: string | null;
  playbook: string | null;
  finding: number | null;
  status: string;
  mode: string;
  result: string | null;
  by: string;
  created_at: string;
  decided_at: string | null;
}

function toDraft(r: DraftRow): Draft {
  return DraftSchema.parse({
    id: r.id,
    org: r.org,
    channel: r.channel,
    target: r.target,
    ...(r.subject === null ? {} : { subject: r.subject }),
    body: r.body,
    ...(r.voice === null ? {} : { voice: r.voice }),
    ...(r.playbook === null ? {} : { playbook: r.playbook }),
    ...(r.finding === null ? {} : { finding: r.finding }),
    status: r.status,
    mode: r.mode,
    ...(r.result === null ? {} : { result: r.result }),
    by: r.by,
    createdAt: r.created_at,
    ...(r.decided_at === null ? {} : { decidedAt: r.decided_at }),
  });
}

const DEFAULT_BATCH_AT = "09:00";

export class OutboundGate {
  constructor(private readonly deps: OutboundDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private at(): string {
    return this.now().toISOString();
  }

  // ---------------------------------------------------------------------------
  // Channels

  /** Every channel of a workspace with its mode. A channel never set is Draft. */
  channels(org: string): OutboundChannelState[] {
    const rows = this.deps.db
      .prepare("SELECT channel, mode, batch_at, auto_by_owner FROM outbound_channels WHERE org = ?")
      .all(org) as { channel: string; mode: string; batch_at: string; auto_by_owner: number }[];
    return OUTBOUND_CHANNELS.map((channel) => {
      const row = rows.find((r) => r.channel === channel);
      const mode = row?.mode === "batch" || row?.mode === "auto" ? row.mode : "draft";
      // Auto only counts when the owner set it on purpose; anything else reads as Draft.
      const auto = mode === "auto" && row?.auto_by_owner === 1;
      return {
        org,
        channel,
        mode: mode === "auto" && !auto ? "draft" : mode,
        batchAt: row?.batch_at ?? DEFAULT_BATCH_AT,
        autoSetByOwner: auto,
      } satisfies OutboundChannelState;
    });
  }

  mode(org: string, channel: OutboundChannel): OutboundMode {
    return this.channels(org).find((c) => c.channel === channel)?.mode ?? "draft";
  }

  /**
   * The trust ladder moves a channel: down to Draft by itself after mistakes, up to Batch or Auto
   * when the owner accepted a promotion. `setMode` reaches Auto only through `autoAllowed`.
   */
  applyLadder(org: string, channel: OutboundChannel, mode: OutboundMode): void {
    this.setMode({ org, channel, mode, explicit: true }, true);
  }

  setMode(input: OutboundSetModeInput, ladder = false): OutboundChannelState[] {
    const current = this.channels(input.org).find((c) => c.channel === input.channel);
    const mode = input.mode ?? current?.mode ?? "draft";
    if (mode === "auto" && !ladder) {
      if (input.explicit !== true || this.deps.autoAllowed?.(input.org, input.channel) !== true) {
        throw new UserError(
          "Auto is offered by the trust ladder after a track record: a channel whose drafts you approved as written is proposed for it in Decisions. Accept that proposal to turn Auto on.",
          409,
        );
      }
    }
    const batchAt = input.batchAt ?? current?.batchAt ?? DEFAULT_BATCH_AT;
    this.deps.db
      .prepare(
        `INSERT INTO outbound_channels (org, channel, mode, batch_at, auto_by_owner) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (org, channel) DO UPDATE SET mode = excluded.mode, batch_at = excluded.batch_at,
           auto_by_owner = excluded.auto_by_owner`,
      )
      .run(input.org, input.channel, mode, batchAt, mode === "auto" ? 1 : 0);
    // Leaving Batch: what is queued waits for the owner one by one.
    if (mode !== "batch") {
      this.deps.db
        .prepare(
          "UPDATE outbound_drafts SET status = 'pending' WHERE org = ? AND channel = ? AND status = 'queued'",
        )
        .run(input.org, input.channel);
    }
    this.deps.changed?.();
    return this.channels(input.org);
  }

  // ---------------------------------------------------------------------------
  // Drafts

  get(id: number): Draft | undefined {
    const row = this.deps.db.prepare("SELECT * FROM outbound_drafts WHERE id = ?").get(id) as
      | DraftRow
      | undefined;
    return row === undefined ? undefined : toDraft(row);
  }

  list(org: string | undefined, limit = 100): Draft[] {
    const rows =
      org === undefined
        ? this.deps.db.prepare("SELECT * FROM outbound_drafts ORDER BY id DESC LIMIT ?").all(limit)
        : this.deps.db
            .prepare("SELECT * FROM outbound_drafts WHERE org = ? ORDER BY id DESC LIMIT ?")
            .all(org, limit);
    return (rows as DraftRow[]).map(toDraft);
  }

  /** Drafts that wait for the owner one by one. */
  pending(): Draft[] {
    return (
      this.deps.db
        .prepare("SELECT * FROM outbound_drafts WHERE status = 'pending' ORDER BY id")
        .all() as DraftRow[]
    ).map(toDraft);
  }

  /** Queued drafts by workspace and channel, in the order they came. */
  queued(): Draft[] {
    return (
      this.deps.db
        .prepare("SELECT * FROM outbound_drafts WHERE status = 'queued' ORDER BY id")
        .all() as DraftRow[]
    ).map(toDraft);
  }

  /**
   * The batches that are due in front of the owner now: a channel in Batch mode whose oldest queued
   * draft is older than the channel's batch time (`batchAt`, the workspace's zone) at its last turn.
   */
  async batchesDue(): Promise<{ org: string; channel: OutboundChannel; drafts: Draft[] }[]> {
    const groups = new Map<string, Draft[]>();
    for (const d of this.queued()) {
      const key = `${d.org}\u0000${d.channel}`;
      groups.set(key, [...(groups.get(key) ?? []), d]);
    }
    const due: { org: string; channel: OutboundChannel; drafts: Draft[] }[] = [];
    for (const drafts of groups.values()) {
      const first = drafts[0];
      if (first === undefined) continue;
      const tz = await this.deps.tz(first.org);
      const state = this.channels(first.org).find((c) => c.channel === first.channel);
      if (state === undefined || state.mode !== "batch") continue;
      if (this.batchTimeReached(first.createdAt, state.batchAt, tz)) {
        due.push({ org: first.org, channel: first.channel, drafts });
      }
    }
    return due;
  }

  /**
   * Whether the batch hour came since `since`: the first `batchAt` after it, in the workspace's zone,
   * has passed. A clock set back finds the batch not due yet.
   */
  private batchTimeReached(since: string, batchAt: string, tz: string): boolean {
    const now = this.now();
    const made = new Date(since);
    if (made.getTime() > now.getTime()) return false;
    const day = localDay(made, tz);
    const sameDay = onceInstant(`${day}T${batchAt}`, tz);
    const first =
      sameDay !== undefined && sameDay.getTime() > made.getTime()
        ? sameDay
        : onceInstant(`${addDays(day, 1)}T${batchAt}`, tz);
    return first !== undefined && first.getTime() <= now.getTime();
  }

  /**
   * Offers an output for sending. It never leaves from here unless the channel is Auto and within its limit, or the
   * caller passes `release: "now"`: the owner's own message, or one the owner's Tell setting lets the captain send.
   * Only the client chat module passes it, after its rails. A Batch channel still queues.
   */
  async submit(
    input: OutboundSubmitInput,
    actor: GateActor,
    options: { release?: "now"; prepared?: (draft: Draft) => void } = {},
  ): Promise<{ draft: Draft; text: string }> {
    const org = actor.kind === "owner" ? input.org : (actor.org ?? input.org);
    if (org === undefined) throw new UserError("Say which workspace this is for.", 400);
    if (actor.kind !== "owner" && input.org !== undefined && input.org !== org) {
      throw new UserError("You offer outputs for your own workspace only.", 409);
    }
    if (!(await this.deps.knownOrg(org))) throw new UserError(`There is no workspace "${org}".`, 404);
    const channel = OutboundChannelSchema.parse(input.channel);
    const found = detectSecrets(`${input.subject ?? ""}\n${input.body}`);
    if (found.length > 0) {
      throw new UserError(
        "The text holds what looks like a secret. Take it out, then offer it again. Nothing was queued.",
        409,
      );
    }
    const mode = this.mode(org, channel);
    const by = actor.kind === "agent" ? actor.id : actor.kind;
    const status: DraftStatus = mode === "batch" ? "queued" : "pending";
    let result: string | undefined;
    if (mode === "auto" && this.sentToday(org, channel, await this.deps.tz(org)) >= AUTO_DAILY_LIMIT) {
      result = `Auto sent its ${AUTO_DAILY_LIMIT} for today, so this waits for you`;
    }
    const info = this.deps.db
      .prepare(
        `INSERT INTO outbound_drafts (org, channel, target, subject, body, voice, playbook, finding, status, mode, result, by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        org,
        channel,
        input.target,
        input.subject ?? null,
        input.body,
        input.voice ?? null,
        input.playbook ?? null,
        input.finding ?? null,
        status,
        mode,
        result ?? null,
        by,
        this.at(),
      );
    const id = Number(info.lastInsertRowid);
    let draft = this.must(id);
    // The caller shows the draft before anything is sent, so what the send needs (its thread) is there when it runs.
    options.prepared?.(draft);
    if (options.release === "now" && mode !== "batch") {
      draft = await this.release(draft, actor.kind === "owner" ? "owner" : "auto");
    } else if (mode === "auto" && result === undefined) {
      draft = await this.release(draft, "auto");
    }
    this.deps.changed?.();
    return { draft, text: this.textFor(draft) };
  }

  private textFor(d: Draft): string {
    switch (d.status) {
      case "queued":
        return "Queued for the owner's next batch. Nothing was sent.";
      case "sent":
        return "Sent by the channel's Auto setting.";
      case "approved":
      case "failed":
        return `${d.result ?? "It did not go."} `.trim();
      default:
        return "Waits for the owner's approval in Decisions. Nothing was sent.";
    }
  }

  private must(id: number): Draft {
    const d = this.get(id);
    if (d === undefined) throw new UserError(`There is no draft ${id}.`, 404);
    return d;
  }

  private sentToday(org: string, channel: string, tz: string): number {
    const rows = this.deps.db
      .prepare(
        "SELECT decided_at FROM outbound_drafts WHERE org = ? AND channel = ? AND mode = 'auto' AND status IN ('sent', 'approved') AND decided_at IS NOT NULL",
      )
      .all(org, channel) as { decided_at: string }[];
    const today = localDay(this.now(), tz);
    return rows.filter((r) => localDay(r.decided_at, tz) === today).length;
  }

  /**
   * Changes the words of a draft that waits. The same scan as a new draft: a text with a secret is refused.
   * Only the owner edits; the handler checks.
   */
  edit(id: number, body: string): Draft {
    const draft = this.must(id);
    if (draft.status !== "pending" && draft.status !== "queued") {
      throw new UserError(`Draft ${id} is ${draft.status}: only a draft that waits can be changed.`, 409);
    }
    if (detectSecrets(body).length > 0) {
      throw new UserError("The text holds what looks like a secret. Take it out, then save it.", 409);
    }
    this.deps.db.prepare("UPDATE outbound_drafts SET body = ? WHERE id = ?").run(body, id);
    const edited = this.must(id);
    this.deps.settled?.(edited);
    this.deps.changed?.();
    return edited;
  }

  /** The owner's decision on one draft. Only the owner reaches this; the handler checks. */
  async decide(id: number, decision: "send" | "discard"): Promise<Draft> {
    const draft = this.must(id);
    if (draft.status !== "pending" && draft.status !== "queued") {
      throw new UserError(`Draft ${id} is ${draft.status} already.`, 409);
    }
    if (decision === "discard") {
      this.setStatus(id, "discarded", "Discarded by the owner");
      this.deps.changed?.();
      const discarded = this.must(id);
      this.deps.settled?.(discarded);
      return discarded;
    }
    const out = await this.release(draft, "owner");
    this.deps.changed?.();
    return out;
  }

  /** Sends or discards every queued draft of a channel in a workspace. */
  async decideBatch(org: string, channel: OutboundChannel, decision: "send" | "discard"): Promise<Draft[]> {
    const drafts = this.queued().filter((d) => d.org === org && d.channel === channel);
    const out: Draft[] = [];
    for (const d of drafts) out.push(await this.decide(d.id, decision));
    return out;
  }

  private setStatus(id: number, status: DraftStatus, result: string | undefined): void {
    this.deps.db
      .prepare("UPDATE outbound_drafts SET status = ?, result = ?, decided_at = ? WHERE id = ?")
      .run(status, result ?? null, this.at(), id);
  }

  /**
   * The one place a transport is called. A draft goes out only here, after the owner's decision or
   * under an Auto channel's limit. Without a transport it is approved and waits, honestly said.
   */
  private async release(draft: Draft, by: "owner" | "auto"): Promise<Draft> {
    // An email with no address (a draft for a client with no main contact) cannot go anywhere.
    if (draft.channel === "email" && !/@[^\s@]+\.[^\s@]+/.test(draft.target)) {
      this.setStatus(
        draft.id,
        "failed",
        "Not sent: the draft has no email address. Mark a contact as the main contact in Business, then draft it again",
      );
      return this.must(draft.id);
    }
    const transport = this.deps.transports?.[draft.channel];
    if (transport === undefined) {
      this.setStatus(
        draft.id,
        "approved",
        "Approved. Nothing was sent: no sender is connected for this channel yet",
      );
      return this.must(draft.id);
    }
    // Claim it first so a second click cannot send the same draft twice.
    const claimed = this.deps.db
      .prepare(
        "UPDATE outbound_drafts SET status = 'approved', decided_at = ? WHERE id = ? AND status IN ('pending', 'queued')",
      )
      .run(this.at(), draft.id);
    if (claimed.changes === 0) return this.must(draft.id);
    try {
      const sent = await transport.send({ ...draft, status: "approved" });
      this.setStatus(draft.id, sent.ok ? "sent" : "failed", `${by === "auto" ? "Auto: " : ""}${sent.detail}`);
    } catch (err) {
      this.setStatus(draft.id, "failed", errorMessage(err));
    }
    const done = this.must(draft.id);
    this.deps.settled?.(done);
    return done;
  }
}
