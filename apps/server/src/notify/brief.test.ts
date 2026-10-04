import { type AttentionEvent, NotificationsSettingsSchema, type ServerEvent } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { EventHub } from "../events/hub.ts";
import { BRIEF_PATH, type DesktopNotice, Notifier } from "./service.ts";

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
  it("opens Today when clicked, on the desktop and in an open tab", async () => {
    const { notifier, tabs, desktop } = setup(
      NotificationsSettingsSchema.parse({ mac: true, browser: true }),
    );
    notifier.brief("2026-10-04", "3 things need you, about 8 min.");
    await settle();
    expect(BRIEF_PATH).toBe("/today");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ kind: "brief", path: "/today", text: "3 things need you, about 8 min." });
    expect(desktop.length + tabs.length).toBeGreaterThan(0);
    for (const n of desktop) expect(n.path).toBe("/today");
  });

  it("tells once per day, however many times it is asked", async () => {
    const { notifier, tabs } = setup();
    notifier.brief("2026-10-04", "a");
    notifier.brief("2026-10-04", "b");
    await settle();
    notifier.brief("2026-10-05", "c");
    await settle();
    expect(tabs.map((t) => t.id)).toEqual(["brief:2026-10-04", "brief:2026-10-05"]);
  });

  it("stays quiet when the owner muted it", async () => {
    const { notifier, tabs, desktop } = setup(NotificationsSettingsSchema.parse({ muted: ["brief"] }));
    notifier.brief("2026-10-04", "a");
    await settle();
    expect(tabs).toEqual([]);
    expect(desktop).toEqual([]);
  });

  it("stays quiet in quiet hours", async () => {
    const { notifier, tabs } = setup(
      NotificationsSettingsSchema.parse({ quiet_from: "07:00", quiet_to: "09:00", quiet_tz: "UTC" }),
    );
    notifier.brief("2026-10-04", "a");
    await settle();
    expect(tabs).toEqual([]);
  });

  it("does not throw when the settings cannot be read", async () => {
    const hub = new EventHub();
    const notifier = new Notifier({
      subject: () => undefined,
      item: () => undefined,
      settings: async () => {
        throw new Error("config unreadable");
      },
      events: hub,
    });
    expect(() => notifier.brief("2026-10-04", "a")).not.toThrow();
    await settle();
  });
});
