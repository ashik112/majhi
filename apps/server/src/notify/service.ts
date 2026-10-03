import type { AttentionEvent, NotificationsSettings, RoomItem } from "@majhi/shared";
import type { EventHub } from "../events/hub.ts";
import {
  type Attention,
  attentionOf,
  groupText,
  inQuietHours,
  pathOf,
  type Subject,
  subjectName,
} from "./attention.ts";

/** An item that was answered within this long never sends anything. */
export const SETTLE_MS = 5_000;
/** Items that settle close together are collected this long, to see whether they are a burst. */
export const COLLECT_MS = 1_500;
/** More than this many notifications in `BURST_WINDOW_MS` become one. */
export const BURST_MAX = 3;
export const BURST_WINDOW_MS = 10_000;
const SEEN_MAX = 2_000;

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
  settings: () => Promise<NotificationsSettings>;
  events: EventHub;
  /**
   * Shows a desktop notification through the host helper: Notification Center on macOS, `notify-send`
   * on Linux and WSL2. Absent without a helper.
   */
  desktop?: (notice: DesktopNotice) => Promise<void>;
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
 * Turns "an item now waits for the owner" into one notification: a desktop banner and an `attention`
 * event for open tabs. One per item, none when the owner answered it within five seconds, and a burst
 * becomes a single "4 things need you". Settings decide the channels, the muted kinds and quiet hours.
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
    const attention = attentionOf(item, subjectName(subject));
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
      this.settled({ task, id: item.id, subject, attention });
    }, SETTLE_MS);
    timer.unref();
    this.timers.set(key, timer);
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

  /** Autonomous mode's daily summary (PRV-74) has no card the owner must answer. Told once per day. */
  autonomySummary(day: string, text: string): void {
    const key = `autonomy:${day}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.enqueue({
      task: "",
      id: key,
      subject: { id: "", title: "majhi", chat: false },
      attention: { kind: "autonomy", text },
      path: "/autonomous",
    });
  }

  /**
   * Something of the captain the owner should know (5.18): a chore it turned off, the daily summary
   * lines. Told once per key, under the kind `autonomy`, linking the Captain page.
   */
  captain(key: string, text: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.enqueue({
      task: "",
      id: key,
      subject: { id: "", title: "majhi", chat: false },
      attention: { kind: "autonomy", text },
      path: "/captain",
    });
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

  private forget(key: string): void {
    const timer = this.timers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(key);
  }

  /** The five seconds passed. It still waits for the owner, so it is a notification. */
  private settled(waiting: Waiting): void {
    const now = this.deps.item(waiting.task, waiting.id);
    if (now === undefined || attentionOf(now, subjectName(waiting.subject)) === undefined) return;
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
          text: groupText(total),
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
          id: `${w.task}:${w.id}`,
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
