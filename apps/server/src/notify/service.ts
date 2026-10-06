import type { AttentionEvent, NotificationsSettings, RoomItem } from "@majhi/shared";
import { decisionsNeedText, roomDecisionId } from "@majhi/shared";
import type { EventHub } from "../events/hub.ts";
import { isDecisionItem } from "../inbox/build.ts";
import { type Attention, attentionOf, inQuietHours, pathOf, type Subject, subjectName } from "./attention.ts";

/** An item that was answered within this long never sends anything. */
export const SETTLE_MS = 5_000;
/** Items that settle close together are collected this long, to see whether they are a burst. */
export const COLLECT_MS = 1_500;
/** More than this many notifications in `BURST_WINDOW_MS` become one. */
export const BURST_MAX = 3;
export const BURST_WINDOW_MS = 10_000;
/** A card the captain is about to answer by itself waits this long before it alerts the owner. */
export const CAPTAIN_GRACE_MS = 120_000;
const SEEN_MAX = 2_000;
/** Where a click on the morning brief's notification goes. */
export const BRIEF_PATH = "/today";

export interface DesktopNotice {
  title: string;
  message: string;
  path: string;
  sound: boolean;
}

export interface NotifierDeps {
  /** The task an item belongs to, or undefined when it is gone. */
  subject: (task: string) => Subject | undefined;
  /** The stored item now, to see whether it is still waiting. */
  item: (task: string, id: string) => RoomItem | undefined;
  /** The task's review card that waits, if any: read again when its hand-off check lands. */
  pendingReview?: (task: string) => RoomItem[];
  settings: () => Promise<NotificationsSettings>;
  events: EventHub;
  /**
   * Shows a desktop notification through the host helper: Notification Center on macOS, `notify-send`
   * on Linux and WSL2. Absent without a helper.
   */
  desktop?: (notice: DesktopNotice) => Promise<void>;
  /**
   * Whether the captain answers this item by itself now (Autonomous is on and the workspace lets it
   * decide). Such an item alerts only if it is still waiting after `CAPTAIN_GRACE_MS`.
   */
  captainHandles?: (item: RoomItem, subject: Subject) => Promise<boolean>;
  now?: () => number;
}

interface Waiting {
  task: string;
  id: string;
  subject: Subject;
  attention: Attention;
  /** Where a notice with no task opens. Default: the board. */
  path?: string;
}

export interface TestResult {
  desktop: "sent" | "off" | "no-helper" | "failed";
  error?: string;
  browser: boolean;
}

/**
 * Turns "a decision now waits for the owner" into one notification: a desktop banner and an `attention`
 * event for open tabs. Only decisions alert (SPEC 5.18), once each by decision id; none when the owner
 * or the captain answered it within five seconds, and a burst becomes a single "4 decisions need you".
 * Settings decide the channels, the muted kinds and quiet hours.
 */
export class Notifier {
  private readonly seen = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private buffer: Waiting[] = [];
  private collect: NodeJS.Timeout | undefined;
  /** When each of the last notifications went out, so a steady drip still groups. */
  private recent: number[] = [];

  constructor(private readonly deps: NotifierDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Every write of a room item comes here. */
  observe(task: string, item: RoomItem): void {
    const key = `${task}:${item.id}`;
    const subject = this.deps.subject(task);
    if (subject === undefined) return;
    const attention = isDecisionItem(item, subject)
      ? attentionOf(item, subjectName(subject), subject.checks)
      : undefined;
    if (attention === undefined) {
      // Answered, replaced or cancelled: if it was still in its quiet wait, it sends nothing.
      this.forget(key);
      return;
    }
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.settled({ task, id: item.id, subject, attention }, true).catch(() => undefined);
    }, SETTLE_MS);
    timer.unref();
    this.timers.set(key, timer);
  }

  /**
   * The hand-off check of a task moved: a review card that was no decision while the check ran is
   * one now (or still is not). Looks again, so it alerts once, when its verdict lands.
   */
  recheck(task: string): void {
    for (const item of this.deps.pendingReview?.(task) ?? []) this.observe(task, item);
  }

  /** A failed update has no room item. It is told once per attempt. */
  updateFailed(attempt: string, reason: string): void {
    const key = `update:${attempt}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.enqueue({
      task: "",
      id: key,
      subject: { id: "", title: "majhi", chat: false },
      attention: { kind: "update", text: `The update failed: ${reason}` },
    });
  }

  /**
   * A question of the captain's that waits for the owner: a chore at its daily limit or a budget that
   * ran out (SPEC 5.18). Told once per key, and only these: what the captain tells without asking
   * (a chore turned off, the daily summary) is read in the log and never alerts.
   */
  captain(key: string, text: string): void {
    const path = key.startsWith("budget:")
      ? "/limits"
      : key.startsWith("captain-cap:")
        ? "/captain"
        : undefined;
    if (path === undefined || this.seen.has(key)) return;
    this.seen.add(key);
    this.enqueue({
      task: "",
      id: key,
      subject: { id: "", title: "majhi", chat: false },
      attention: { kind: "autonomy", text },
      path,
    });
  }

  /**
   * An incident (SPEC 5.18, Ops watch). A high one tells the owner now: it is never held for quiet hours,
   * never muted and never folded into a burst, and the desktop banner goes out even while a tab is open,
   * because it must be seen. A medium one waits out quiet hours like a decision. Low ones never come here.
   */
  async incident(n: {
    id: number;
    text: string;
    severity: "high" | "medium";
    repeat: boolean;
  }): Promise<void> {
    const settings = await this.deps.settings();
    const now = this.now();
    if (
      n.severity !== "high" &&
      inQuietHours(now, { from: settings.quiet_from, to: settings.quiet_to, tz: settings.quiet_tz })
    ) {
      return;
    }
    const event = {
      id: `incident:${n.id}${n.repeat ? ":repeat" : ""}`,
      kind: "incident" as const,
      title: "majhi",
      text: n.text,
      path: "/watch",
      count: 1,
    };
    this.emit(event, settings);
    if (settings.mac && this.deps.desktop !== undefined) {
      await this.deps
        .desktop({ title: "majhi", message: n.text, path: "/watch", sound: settings.sound })
        .catch(() => undefined);
    }
  }

  /**
   * The morning brief is ready (SPEC 5.18): one desktop notification and one `attention` event per day, whose
   * click opens Today. It is not a decision, so it never joins a burst; the owner's mute and quiet hours still
   * apply. Told once per day, whatever calls it.
   */
  brief(day: string, text: string): void {
    const key = `brief:${day}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    void this.deps
      .settings()
      .then(async (settings) => {
        if (settings.muted.includes("brief")) return;
        if (
          inQuietHours(this.now(), {
            from: settings.quiet_from,
            to: settings.quiet_to,
            tz: settings.quiet_tz,
          })
        ) {
          return;
        }
        await this.deliver(
          { id: key, kind: "brief", title: "Morning brief", text, path: BRIEF_PATH, count: 1 },
          settings,
        );
      })
      .catch(() => undefined);
  }

  /** The test button: goes to each channel that is on, with no waiting, muting or grouping. */
  async test(): Promise<TestResult> {
    const settings = await this.deps.settings();
    const text = "This is a test. majhi can reach you here.";
    let desktop: TestResult["desktop"] = "off";
    let error: string | undefined;
    // `notifications.mac` keeps its name on every OS: majhi.yaml files have it.
    if (settings.mac) {
      if (this.deps.desktop === undefined) desktop = "no-helper";
      else {
        try {
          await this.deps.desktop({ title: "majhi", message: text, path: "/", sound: settings.sound });
          desktop = "sent";
        } catch (err) {
          desktop = "failed";
          error = err instanceof Error ? err.message : "The notification failed.";
        }
      }
    }
    this.emit(
      { id: `test:${this.now()}`, kind: "test", title: "majhi", text, path: "/", count: 1 },
      settings,
    );
    return { desktop, ...(error === undefined ? {} : { error }), browser: settings.browser };
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    clearTimeout(this.collect);
    this.buffer = [];
  }

  /** Drops an alert still in its quiet wait. It was never sent, so a later decision for the item may still alert. */
  private forget(key: string): void {
    const timer = this.timers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(key);
    this.seen.delete(key);
  }

  /** The five seconds passed. It still waits for the owner, so it is a notification, unless the captain answers it. */
  private async settled(waiting: Waiting, first: boolean): Promise<void> {
    const now = this.deps.item(waiting.task, waiting.id);
    // The task may have moved on since the item was written (its checks started): read it again.
    const subject = this.deps.subject(waiting.task) ?? waiting.subject;
    if (now === undefined || !isDecisionItem(now, subject)) {
      // Not a decision now: when it becomes one it must be able to alert.
      this.seen.delete(`${waiting.task}:${waiting.id}`);
      return;
    }
    if (first && (await this.deps.captainHandles?.(now, waiting.subject)) === true) {
      const key = `${waiting.task}:${waiting.id}`;
      const timer = setTimeout(() => {
        this.timers.delete(key);
        void this.settled(waiting, false).catch(() => undefined);
      }, CAPTAIN_GRACE_MS);
      timer.unref();
      this.timers.set(key, timer);
      return;
    }
    this.enqueue(waiting);
  }

  private enqueue(waiting: Waiting): void {
    this.buffer.push(waiting);
    if (this.collect !== undefined) return;
    this.collect = setTimeout(() => {
      this.collect = undefined;
      const batch = this.buffer;
      this.buffer = [];
      void this.send(batch).catch(() => undefined);
    }, COLLECT_MS);
    this.collect.unref();
  }

  private async send(batch: Waiting[]): Promise<void> {
    if (batch.length === 0) return;
    const settings = await this.deps.settings();
    const now = this.now();
    this.recent = this.recent.filter((at) => now - at < BURST_WINDOW_MS);
    const wanted = batch.filter((w) => !settings.muted.includes(w.attention.kind));
    if (wanted.length === 0) return;
    if (inQuietHours(now, { from: settings.quiet_from, to: settings.quiet_to, tz: settings.quiet_tz }))
      return;
    const total = this.recent.length + wanted.length;
    if (total > BURST_MAX) {
      for (let i = 0; i < wanted.length; i += 1) this.recent.push(now);
      await this.deliver(
        {
          id: `group:${now}`,
          kind: "group",
          title: "majhi",
          text: decisionsNeedText(total),
          path: "/",
          count: total,
        },
        settings,
      );
      return;
    }
    for (const w of wanted) {
      this.recent.push(now);
      await this.deliver(
        {
          id: w.task === "" ? w.id : roomDecisionId(w.task, w.id),
          kind: w.attention.kind,
          ...(w.task === "" ? {} : { task: w.task }),
          title: w.subject.title,
          text: w.attention.text,
          path: w.task === "" ? (w.path ?? "/") : pathOf(w.subject),
          count: 1,
        },
        settings,
      );
    }
  }

  private async deliver(
    event: Omit<AttentionEvent, "type" | "browser" | "sound">,
    settings: NotificationsSettings,
  ): Promise<void> {
    this.emit(event, settings);
    // A tab that can pop browser notifications reports it on /api/events every 20 s. While one did
    // within the last minute, that tab tells the owner (and its click focuses majhi), so the desktop
    // banner would only repeat it. The server cannot see whether the tab popped, so a fresh report is
    // the signal; with no tab, or none allowed to, the desktop banner goes out as before.
    const tabTells = settings.browser && this.deps.events.tabs.popping(this.now());
    if (settings.mac && !tabTells && this.deps.desktop !== undefined) {
      await this.deps
        .desktop({ title: "majhi", message: event.text, path: event.path, sound: settings.sound })
        .catch(() => undefined);
    }
  }

  private emit(
    event: Omit<AttentionEvent, "type" | "browser" | "sound">,
    settings: NotificationsSettings,
  ): void {
    this.deps.events.send({ type: "attention", ...event, browser: settings.browser, sound: settings.sound });
  }
}
