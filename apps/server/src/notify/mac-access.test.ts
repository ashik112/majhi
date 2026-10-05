import { describe, expect, it } from "vitest";
import { type DesktopResult, MacNotifyAccess } from "./mac-access.ts";

const notice = { title: "majhi", message: "ACM-12 needs approval", path: "/t/ACM-12", sound: false };
const BLOCKED: DesktopResult = { shown: false, clickable: false, blocked: true };
const SHOWN: DesktopResult = { shown: true, clickable: true };

function setup(first: DesktopResult) {
  let next = first;
  const calls: string[] = [];
  const clock = ["2026-10-05T08:00:00.000Z", "2026-10-05T09:00:00.000Z", "2026-10-05T10:00:00.000Z"];
  const access = new MacNotifyAccess(
    {
      notify: async () => {
        calls.push("notify");
        return next;
      },
      openSettings: async () => {
        calls.push("settings");
        return { opened: true };
      },
    },
    () => new Date(clock.shift() ?? "2026-10-05T11:00:00.000Z"),
  );
  return { access, calls, set: (r: DesktopResult) => (next = r) };
}

describe("Mac notification access", () => {
  it("raises one item however many alerts are blocked, with the two buttons and the step", async () => {
    const { access } = setup(BLOCKED);
    await expect(access.send(notice)).rejects.toThrow("Mac notifications are off for majhi");
    await expect(access.send(notice)).rejects.toThrow();
    await expect(access.send(notice)).rejects.toThrow();

    const items = access.decision();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "notify:mac",
      kind: "notifications",
      title: "Mac notifications are off for majhi",
      // The first blocked alert dates it; later ones do not move it.
      at: "2026-10-05T08:00:00.000Z",
      options: [
        { id: "settings", label: "Open Notification settings", primary: true },
        { id: "check", label: "Check again" },
      ],
      link: { kind: "setup", section: "notifications" },
    });
    expect(items[0]?.sentence).toContain("turn on Allow notifications");
  });

  it("stays while the check is blocked, and clears when a test notification shows", async () => {
    const { access, set } = setup(BLOCKED);
    await expect(access.send(notice)).rejects.toThrow();

    await expect(access.answer("check")).rejects.toThrow("Still off");
    expect(access.decision()).toHaveLength(1);

    set(SHOWN);
    await access.answer("check");
    expect(access.decision()).toEqual([]);
  });

  it("clears when a real alert shows, and is raised again if it is blocked again", async () => {
    const { access, set } = setup(BLOCKED);
    await expect(access.send(notice)).rejects.toThrow();
    set(SHOWN);
    await access.send(notice);
    expect(access.decision()).toEqual([]);

    set(BLOCKED);
    await expect(access.send(notice)).rejects.toThrow();
    expect(access.decision()).toHaveLength(1);
  });

  it("opens the settings pane through the helper, and refuses an unknown option", async () => {
    const { access, calls } = setup(BLOCKED);
    await access.answer("settings");
    expect(calls).toEqual(["settings"]);
    await expect(access.answer("other")).rejects.toThrow("not one of the options");
  });

  it("raises nothing while notifications work", async () => {
    const { access } = setup(SHOWN);
    await access.send(notice);
    expect(access.decision()).toEqual([]);
  });
});
