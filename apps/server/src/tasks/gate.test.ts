import { type GateOrigin, GateOriginSchema, LimitsSettingsSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { type Admission, admit, type GateCounts } from "./gate.ts";

// The defaults come from the schema, not from numbers repeated here.
const limits = LimitsSettingsSchema.parse({});
const ORIGINS = GateOriginSchema.options;
const MAKERS_OF_IDEAS: readonly GateOrigin[] = ["agent", "finding"];
const others = ORIGINS.filter((o) => !MAKERS_OF_IDEAS.includes(o));
const counts = (running: number, open: number): GateCounts => ({
  running,
  openByOthers: { acme: open, globex: 0 },
});
const run = (origin: GateOrigin, c: GateCounts, wantsStart = true): Admission =>
  admit({ origin, org: "acme", wantsStart, counts: c, limits });

describe("the task gate", () => {
  it("starts every origin under the running cap and queues it at and over the cap", () => {
    for (const origin of others) {
      expect(run(origin, counts(limits.tasks_running - 1, 0)), `${origin} under`).toEqual({ kind: "start" });
      expect(run(origin, counts(limits.tasks_running, 0)), `${origin} at`).toEqual({
        kind: "queue",
        reason: "running-cap",
      });
      expect(run(origin, counts(limits.tasks_running + 5, 0)), `${origin} over`).toEqual({
        kind: "queue",
        reason: "running-cap",
      });
    }
  });

  it("makes whatever an agent or a finding creates an idea, with room or without", () => {
    for (const origin of MAKERS_OF_IDEAS) {
      expect(run(origin, counts(0, 0)), origin).toEqual({ kind: "idea", reason: "agent-made" });
      expect(run(origin, counts(0, 0), false), origin).toEqual({ kind: "idea", reason: "agent-made" });
      expect(run(origin, counts(limits.tasks_running + 1, limits.open_by_others + 1)), origin).toEqual({
        kind: "idea",
        reason: "agent-made",
      });
    }
  });

  it("files the captain's, incidents', client chats' and schedules' tasks as ideas at the open cap, never the owner's", () => {
    for (const origin of others.filter((o) => o !== "owner")) {
      expect(run(origin, counts(0, limits.open_by_others - 1)), `${origin} under`).toEqual({ kind: "start" });
      expect(run(origin, counts(0, limits.open_by_others)), `${origin} at`).toEqual({
        kind: "idea",
        reason: "open-cap",
      });
      expect(run(origin, counts(0, limits.open_by_others + 7), false), `${origin} over`).toEqual({
        kind: "idea",
        reason: "open-cap",
      });
    }
    expect(run("owner", counts(0, limits.open_by_others + 50))).toEqual({ kind: "start" });
    expect(run("owner", counts(limits.tasks_running, limits.open_by_others + 50))).toEqual({
      kind: "queue",
      reason: "running-cap",
    });
  });

  it("counts the open tasks of the task's own workspace only", () => {
    const full = counts(0, limits.open_by_others);
    expect(admit({ origin: "captain", org: "globex", wantsStart: true, counts: full, limits })).toEqual({
      kind: "start",
    });
  });
});
