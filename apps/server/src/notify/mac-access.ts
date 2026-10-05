import { NOTIFY_ACCESS_DECISION_ID, type OwnerDecision } from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { DesktopNotice } from "./service.ts";

/** What the host helper says a desktop notification came to. `blocked`: macOS has it off for majhi. */
export type DesktopResult = { shown: boolean; clickable: boolean; blocked?: true | undefined };

export interface MacAccessHost {
  notify(notice: DesktopNotice): Promise<DesktopResult>;
  openSettings(): Promise<{ opened: boolean }>;
}

/** The test notification "Check again" sends. It has no sound and a click opens the board. */
const CHECK_NOTICE: DesktopNotice = {
  title: "majhi",
  message: "Notifications work. majhi can reach you here.",
  path: "/",
  sound: false,
};

export const NOTIFY_BLOCKED_MESSAGE =
  "Mac notifications are off for majhi. Turn on Allow notifications for majhi in System Settings, Notifications.";

/**
 * Whether the Mac lets majhi's notifier show notifications. The host helper tells every attempt's outcome;
 * a `blocked` one (macOS exit code 3) raises one decision, "Mac notifications are off for majhi", and a
 * shown notification, from an alert or from "Check again", clears it. majhi never works around it with
 * another program: only the owner can turn the switch on, and the decision tells them the step.
 */
export class MacNotifyAccess {
  private since: string | undefined;

  constructor(
    private readonly host: MacAccessHost,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** A desktop notification through the helper. Throws when it was blocked, so callers see it failed. */
  async send(notice: DesktopNotice): Promise<void> {
    const result = await this.host.notify(notice);
    this.record(result);
    if (result.blocked === true) throw new Error(NOTIFY_BLOCKED_MESSAGE);
  }

  /** "Open Notification settings": the pane where the owner turns the switch on. */
  async openSettings(): Promise<void> {
    const { opened } = await this.host.openSettings();
    if (!opened) {
      throw new UserError(
        "majhi could not open System Settings. Open it, choose Notifications, find majhi and turn on Allow notifications.",
        409,
      );
    }
  }

  /** "Check again": a test notification. The decision clears when it shows, and stays when it does not. */
  async check(): Promise<void> {
    let result: DesktopResult;
    try {
      result = await this.host.notify(CHECK_NOTICE);
    } catch (err) {
      throw new UserError(err instanceof Error ? err.message : "The test notification failed.", 409);
    }
    this.record(result);
    if (result.blocked === true) {
      throw new UserError("Still off. Turn on Allow notifications for majhi, then check again.", 409);
    }
  }

  /** The decision's answer: `settings` or `check`. */
  async answer(option: string): Promise<void> {
    if (option === "settings") await this.openSettings();
    else if (option === "check") await this.check();
    else throw new UserError(`"${option}" is not one of the options.`, 400);
  }

  /** The one decision while notifications are blocked, none otherwise. */
  decision(): OwnerDecision[] {
    if (this.since === undefined) return [];
    return [
      {
        id: NOTIFY_ACCESS_DECISION_ID,
        kind: "notifications",
        title: "Mac notifications are off for majhi",
        sentence:
          "Open Notification settings, find majhi in the list and turn on Allow notifications. Then press Check again.",
        options: [
          { id: "settings", label: "Open Notification settings", primary: true },
          { id: "check", label: "Check again" },
        ],
        at: this.since,
        link: { kind: "setup", section: "notifications" },
      },
    ];
  }

  private record(result: DesktopResult): void {
    if (result.blocked === true) this.since ??= this.now().toISOString();
    else if (result.shown) this.since = undefined;
  }
}
