import type { AutonomyEvent } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { agendaHandlers } from "./handlers.ts";
import { overnightOf } from "./overnight.ts";
import type { AgendaService } from "./service.ts";

let seq = 0;
const ev = (over: Partial<AutonomyEvent>): AutonomyEvent => ({
  seq: ++seq,
  at: "2026-10-04T02:00:00.000Z",
  kind: "task",
  text: "x",
  ...over,
});

describe("what happened overnight", () => {
  it("counts a task once however far it went, and merges and failures apart", () => {
    const out = overnightOf({
      events: [
        ev({ task: "ACM-1", status: "review" }),
        ev({ task: "ACM-1", kind: "decision", outcome: "applied", command: "tasks.merge" }),
        ev({ task: "ACM-2", status: "done" }),
        ev({ task: "ACM-3", kind: "approval", outcome: "failed" }),
        ev({ kind: "refused", text: "Refused: push" }),
        ev({ task: "ACM-4", kind: "answer" }),
      ],
      title: (t) => ({ "ACM-1": "Move the notes export", "ACM-2": "Fix the invoice total" })[t],
      upkeep: [{ chore: "ship", task: "ACM-5" }, { chore: "memory" }, { chore: "cleanup" }],
    });
    expect(out.shipped.map((s) => s.task).sort()).toEqual(["ACM-1", "ACM-2", "ACM-5"]);
    expect(out.shipped.find((s) => s.task === "ACM-1")?.title).toBe("Move the notes export");
    expect(out.shipped.find((s) => s.task === "ACM-5")?.title).toBe("ACM-5");
    expect(out.merged).toBe(2);
    expect(out.failed).toBe(2);
    expect(out.decided).toBe(1);
    expect(out.upkeep).toBe(2);
  });

  it("is all zeros for a quiet night", () => {
    expect(overnightOf({ events: [], title: () => undefined, upkeep: [] })).toEqual({
      shipped: [],
      merged: 0,
      failed: 0,
      decided: 0,
      upkeep: 0,
    });
  });
});

describe("who reads and schedules the agenda", () => {
  const budgets: number[] = [];
  const agenda = {
    today: async (input: { org?: string }, withBrief: boolean) => ({ org: input.org ?? "all", withBrief }),
    setBudgetMinutes: (minutes: number) => budgets.push(minutes),
    ensureBrief: async () => undefined,
    dismissBrief: () => undefined,
  } as unknown as AgendaService;
  const handlers = agendaHandlers({
    agenda,
    lanes: {
      orgOf: (task: string) => (task === "lane-acme" ? "acme" : undefined),
      boss: async () => "majhi-captain",
    },
    store: { tasks: { get: () => ({ org: "acme" }) } },
  } as never);
  const as = (actor: object, task?: string) =>
    ({ command: "agenda.today", meta: { actor, ...(task === undefined ? {} : { task }) } }) as never;
  const agent = as({ kind: "agent", id: "acme-builder" }, "acme-1");
  const captainInLane = as({ kind: "agent", id: "majhi-captain" }, "lane-acme");
  const owner = as({ kind: "owner" });

  it("refuses an agent other than the captain on every command", async () => {
    await expect(handlers["agenda.today"]({}, agent)).rejects.toThrow("only the captain reads it");
    await expect(handlers["agenda.configure"]({ budgetMinutes: 30 }, agent)).rejects.toThrow(
      "only the captain",
    );
    await expect(handlers["agenda.brief"]({}, agent)).rejects.toThrow("only the captain");
    await expect(handlers["agenda.dismissBrief"]({ day: "2026-10-04" }, agent)).rejects.toThrow(
      "only the captain",
    );
    expect(budgets).toEqual([]);
  });

  it("lets the captain read its lane's workspace and set the review time", async () => {
    await expect(handlers["agenda.today"]({}, captainInLane)).resolves.toEqual({
      org: "acme",
      withBrief: false,
    });
    await expect(handlers["agenda.today"]({ org: "globex" }, captainInLane)).rejects.toThrow(
      "your own workspace only",
    );
    await expect(handlers["agenda.configure"]({ budgetMinutes: 30 }, captainInLane)).resolves.toEqual({
      org: "acme",
      withBrief: false,
    });
    expect(budgets).toEqual([30]);
  });

  it("answers the owner for any workspace", async () => {
    await expect(handlers["agenda.today"]({}, owner)).resolves.toEqual({ org: "all", withBrief: true });
  });
});
