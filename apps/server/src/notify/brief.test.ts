import { type AttentionEvent, NotificationsSettingsSchema, type ServerEvent } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { EventHub } from "../events/hub.ts";
import { type DesktopNotice, Notifier } from "./service.ts";

/** The morning brief's notification: once a day, to the right page, and never against the owner's settings. */

function setup(
  settings = NotificationsSettingsSchema.parse({}),
  now = Date.parse("2026-10-04T08:00:00.000Z"),
) {
  const hub = new EventHub();
  const tabs: AttentionEvent[] = [];
  const desktop: DesktopNotice[] = [];
  hub.subscribe((e: ServerEvent) => {
    if (e.type === "attention") tabs.push(e);
  });
  const notifier = new Notifier({
    subject: () => undefined,
    item: () => undefined,
    settings: async () => settings,
    events: hub,
    desktop: async (n) => {
      desktop.push(n);
    },
    now: () => now,
  });
  return { notifier, tabs, desktop };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("the brief notification", () => {
  it("tells once per day, however many times it is asked", async () => {
    const { notifier, tabs } = setup();
    notifier.brief("2026-10-04", "a");
    notifier.brief("2026-10-04", "b");
    await settle();
    notifier.brief("2026-10-05", "c");
    await settle();
    expect(tabs.map((t) => t.id)).toEqual(["brief:2026-10-04", "brief:2026-10-05"]);
  });
});
