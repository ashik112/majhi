import { describe, expect, it } from "vitest";
import { leadMayStart } from "./lead-start.ts";

const lead = { id: "ACM-1", org: "acme", team: ["acme-lead", "acme-builder"], status: "running" as const };
const child = { id: "ACM-2", org: "acme", team: ["acme-builder"], parent: "ACM-1", status: "inbox" as const };
const sibling = { id: "ACM-3", org: "acme", team: ["acme-builder"], status: "ready" as const };
const elsewhere = {
  id: "GLX-1",
  org: "globex",
  team: ["globex-builder"],
  parent: "ACM-1",
  status: "inbox" as const,
};
const noOrg = { id: "LOCAL-1", team: [] as string[], parent: "ACM-1", status: "inbox" as const };

const may = (target: Parameters<typeof leadMayStart>[0]["target"], setting: "children" | "org" | "off") =>
  leadMayStart({ callerTask: lead, callerAgent: "acme-lead", target, setting });

describe("leadMayStart", () => {
  it("lets a lead start its own subtask under every setting but off", () => {
    expect(may(child, "children")).toEqual({ ok: true });
    expect(may(child, "org")).toEqual({ ok: true });
    expect(may(child, "off")).toMatchObject({ ok: false, hard: false });
  });

  it("allows another task of the org only under `org`", () => {
    expect(may(sibling, "children")).toMatchObject({ ok: false, hard: false });
    expect(may(sibling, "org")).toEqual({ ok: true });
    expect(may(sibling, "off")).toMatchObject({ ok: false, hard: false });
  });

  it("refuses another org outright, whatever the setting", () => {
    for (const setting of ["children", "org", "off"] as const)
      expect(may(elsewhere, setting)).toMatchObject({ ok: false, hard: true });
  });

  it("refuses a task with no org outright, and sends two LOCAL tasks to the owner", () => {
    for (const setting of ["children", "org"] as const) {
      expect(may(noOrg, setting)).toMatchObject({ ok: false, hard: true });
      expect(
        leadMayStart({
          callerTask: { id: "LOCAL-2", team: ["acme-lead"] },
          callerAgent: "acme-lead",
          target: { id: "LOCAL-3", team: [], parent: "LOCAL-2", status: "inbox" },
          setting,
        }),
      ).toMatchObject({ ok: false, hard: false });
    }
  });

  it("refuses an agent that is not the lead of the calling task", () => {
    for (const setting of ["children", "org"] as const)
      expect(
        leadMayStart({ callerTask: lead, callerAgent: "acme-builder", target: child, setting }),
      ).toMatchObject({ ok: false, hard: false });
  });

  it("does not let a lead start its own task", () => {
    expect(may(lead, "org")).toMatchObject({ ok: false, hard: false });
    expect(may(lead, "children")).toMatchObject({ ok: false, hard: false });
  });

  it("starts only a task that never ran, and leaves the rest to the owner", () => {
    for (const setting of ["children", "org"] as const) {
      expect(may({ ...child, status: "ready" }, setting)).toEqual({ ok: true });
      expect(may({ ...child, status: "running" }, setting)).toEqual({ ok: true, running: true });
      for (const status of ["paused", "review", "mr"] as const)
        expect(may({ ...child, status }, setting)).toMatchObject({ ok: false, hard: false });
      expect(may({ ...child, status: "done" }, setting)).toMatchObject({ ok: false, hard: true });
    }
  });
});
