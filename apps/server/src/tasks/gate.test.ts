import { type GateOrigin, GateOriginSchema, LimitsSettingsSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { type Admission, admit, admitRunning, type GateCounts } from "./gate.ts";

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
  it.each<[string, () => void]>([
    [
      "the running cap",
      () => {
        for (const origin of others) {
          expect(run(origin, counts(limits.tasks_running - 1, 0)), `${origin} under`).toEqual({
            kind: "start",
          });
          expect(run(origin, counts(limits.tasks_running, 0)), `${origin} at`).toEqual({
            kind: "queue",
            reason: "running-cap",
          });
          expect(run(origin, counts(limits.tasks_running + 5, 0)), `${origin} over`).toEqual({
            kind: "queue",
            reason: "running-cap",
          });
        }
      },
    ],
    [
      "the open cap, which files the captain's, client chats' and schedules' tasks as ideas, never the owner's or an incident's",
      () => {
        for (const origin of others.filter((o) => o !== "owner" && o !== "incident")) {
          expect(run(origin, counts(0, limits.open_by_others - 1)), `${origin} under`).toEqual({
            kind: "start",
          });
          expect(run(origin, counts(0, limits.open_by_others)), `${origin} at`).toEqual({
            kind: "idea",
            reason: "open-cap",
          });
          expect(run(origin, counts(0, limits.open_by_others + 7), false), `${origin} over`).toEqual({
            kind: "idea",
            reason: "open-cap",
          });
        }
        // An incident is reacting work: over the open cap it still starts, and at the running cap it queues.
        for (const origin of ["incident", "owner"] as const) {
          expect(run(origin, counts(0, limits.open_by_others + 50))).toEqual({ kind: "start" });
          expect(run(origin, counts(limits.tasks_running, limits.open_by_others + 50))).toEqual({
            kind: "queue",
            reason: "running-cap",
          });
        }
      },
    ],
  ])("starts every origin under the running cap and queues it at and over the cap: %s", (_cap, check) => {
    check();
  });

  it("makes a resume wait in line like a start when the cap is full", () => {
    expect(admitRunning({ running: limits.tasks_running }, limits)).toEqual({
      kind: "queue",
      reason: "running-cap",
    });
    expect(admitRunning({ running: limits.tasks_running - 1 }, limits)).toEqual({ kind: "start" });
  });
});
