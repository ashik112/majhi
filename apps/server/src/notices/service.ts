import { NOTICE_DAYS, type NoticeList, type NoticesMarkReadInput, type OwnerDecision, type UpdateStatus } from "@majhi/shared";
import type { EventHub } from "../events/hub.ts";
import type { Store } from "../store/index.ts";
import { buildFeed } from "./feed.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Each source is read this far; the feed keeps the newest `NOTICE_LIMIT` of all of them. */
const PER_SOURCE = 150;

/**
 * The bell's feed (`notices.list`), derived on read from the records each event already lives in,
 * and the owner's marks (`notices.markRead`). Nothing else is stored.
 */
export class NoticesService {
  constructor(
    private readonly deps: {
      store: Pick<Store, "notices" | "deploys">;
      events: Pick<EventHub, "emit">;
      /** What waits for the owner now. */
      decisions: () => Promise<OwnerDecision[]>;
      update: () => Promise<UpdateStatus | undefined>;
      now?: () => Date;
    },
  ) {}

  async list(org?: string): Promise<NoticeList> {
    const { store } = this.deps;
    const since = new Date(this.now().getTime() - NOTICE_DAYS * DAY_MS).toISOString();
    const [decisions, update] = await Promise.all([this.deps.decisions(), this.deps.update()]);
    return buildFeed({
      decisions,
      clientLines: store.notices.clientLines(since, PER_SOURCE),
      taskStatuses: store.notices.taskStatuses(since, PER_SOURCE),
      bugs: store.notices.captainBugs(since, PER_SOURCE),
      incidents: store.notices.incidents(since, PER_SOURCE),
      deploys: store.deploys.endedSince(since, PER_SOURCE),
      update,
      marks: store.notices.marks(),
      org,
      since,
    });
  }

  /**
   * Reads everything up to a time (never later than now, never back), or one row. Tells every tab.
   * A decision's time is when it was last looked at, not when it began, so reading up to a time also
   * reads the decisions that wait right now: the badge clears.
   */
  async markRead(input: NoticesMarkReadInput): Promise<void> {
    const { notices } = this.deps.store;
    const now = this.now();
    const stamp = now.toISOString();
    const forget = new Date(now.getTime() - (NOTICE_DAYS + 1) * DAY_MS).toISOString();
    if ("upTo" in input) {
      const upTo = Date.parse(input.upTo);
      // A time in the future would hide what has not happened yet; an invented one is read as "now".
      const clamped = Number.isNaN(upTo) ? now.getTime() : Math.min(upTo, now.getTime());
      notices.markSeen(new Date(clamped).toISOString());
      const waiting = (await this.list()).notices.filter((n) => n.needsYou && !n.read);
      notices.markRows(
        waiting.map((n) => n.id),
        stamp,
        forget,
      );
    } else {
      notices.markRows([input.id], stamp, forget);
    }
    this.deps.events.emit(["notices"]);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
