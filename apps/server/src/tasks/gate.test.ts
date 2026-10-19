import { describe, expect, it } from "vitest";
import { type Admission, admit, type GateCounts, type Origin } from "./gate.ts";

const limits = { tasks_running: 4, open_by_others: 5 };
const ORIGINS: Origin[] = ["owner", "captain", "agent", "incident", "client-chat", "schedule", "finding"];
const counts = (running: number, open: number): GateCounts => ({
  running,
  openByOthers: { acme: open, globex: 0 },
});
const run = (origin: Origin, c: GateCounts, wantsStart = true): Admission =>
  admit({ origin, org: "acme", wantsStart, counts: c, limits });

describe("the task gate", () => {
  it("lets every origin that is not an agent's start under the running cap and queues it at the cap", () => {
    for (const origin of ORIGINS.filter((o) => o !== "agent" && o !== "finding")) {
      expect(run(origin, counts(3, 0)), `${origin} at 3 running`).toEqual({ kind: "start" });
      expect(run(origin, counts(4, 0)), `${origin} at 4 running`).toEqual({
        kind: "queue",
        reason: "running-cap",
      });
      expect(run(origin, counts(9, 0)), `${origin} over the cap`).toEqual({
        kind: "queue",
        reason: "running-cap",
      });
    }
  });

  it("files a task nobody asked to start, for every origin that may", () => {
    for (const origin of ORIGINS.filter((o) => o !== "agent" && o !== "finding")) {
      expect(run(origin, counts(4, 0), false), origin).toEqual({ kind: "file" });
    }
  });

  it("makes whatever an agent or a finding creates an idea, however much room there is and whatever it asks", () => {
    for (const origin of ["agent", "finding"] as const) {
      for (const wantsStart of [true, false]) {
        expect(run(origin, counts(0, 0), wantsStart), `${origin} start ${wantsStart}`).toEqual({
          kind: "idea",
          reason: "agent-made",
        });
        expect(run(origin, counts(9, 9), wantsStart)).toEqual({ kind: "idea", reason: "agent-made" });
      }
    }
  });

  it("files a captain, incident, client chat or schedule task as an idea once the workspace has 5 open tasks of others", () => {
    for (const origin of ["captain", "incident", "client-chat", "schedule"] as const) {
      expect(run(origin, counts(0, 4)), `${origin} at 4 open`).toEqual({ kind: "start" });
      expect(run(origin, counts(0, 5)), `${origin} at 5 open`).toEqual({ kind: "idea", reason: "open-cap" });
      expect(run(origin, counts(0, 12), false), `${origin} over, not started`).toEqual({
        kind: "idea",
        reason: "open-cap",
      });
    }
  });

  it("counts the open tasks of one workspace only", () => {
    const full = counts(0, 5);
    expect(admit({ origin: "captain", org: "globex", wantsStart: true, counts: full, limits })).toEqual({
      kind: "start",
    });
    expect(admit({ origin: "captain", org: "unknown", wantsStart: true, counts: full, limits })).toEqual({
      kind: "start",
    });
  });

  it("never turns the owner's task into an idea, whatever is open or running", () => {
    expect(run("owner", counts(0, 50))).toEqual({ kind: "start" });
    expect(run("owner", counts(4, 50))).toEqual({ kind: "queue", reason: "running-cap" });
    expect(run("owner", counts(4, 50), false)).toEqual({ kind: "file" });
  });

  it("queues a start whose project is busy, after checking the running cap first", () => {
    expect(
      admit({
        origin: "owner",
        org: "acme",
        wantsStart: true,
        counts: { ...counts(1, 0), projectBusy: true },
        limits,
      }),
    ).toEqual({
      kind: "queue",
      reason: "project-busy",
    });
    expect(
      admit({
        origin: "owner",
        org: "acme",
        wantsStart: true,
        counts: { ...counts(4, 0), projectBusy: true },
        limits,
      }),
    ).toEqual({
      kind: "queue",
      reason: "running-cap",
    });
  });

  it("with open_by_others at 0, every task of the captain, incidents, clients and schedules is an idea", () => {
    const none = { tasks_running: 4, open_by_others: 0 };
    for (const origin of ["captain", "incident", "client-chat", "schedule"] as const) {
      expect(admit({ origin, org: "acme", wantsStart: true, counts: counts(0, 0), limits: none })).toEqual({
        kind: "idea",
        reason: "open-cap",
      });
    }
  });
});
