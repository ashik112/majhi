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

describe("the agenda commands are the owner's", () => {
  const agenda = {
    today: async () => ({ ok: true }),
    setBudgetMinutes: () => undefined,
    ensureBrief: async () => undefined,
    dismissBrief: () => undefined,
  } as unknown as AgendaService;
  const handlers = agendaHandlers(agenda);
  const agent = { command: "agenda.today", meta: { actor: { kind: "agent", id: "acme-builder" } } } as never;
  const owner = { command: "agenda.today", meta: { actor: { kind: "owner" } } } as never;

  it("refuses an agent, the captain included, on every command", async () => {
    await expect(handlers["agenda.today"]({}, agent)).rejects.toThrow(/owner's/);
    await expect(handlers["agenda.configure"]({ budgetMinutes: 30 }, agent)).rejects.toThrow(/owner's/);
    await expect(handlers["agenda.brief"]({}, agent)).rejects.toThrow(/owner's/);
    await expect(handlers["agenda.dismissBrief"]({ day: "2026-10-04" }, agent)).rejects.toThrow(/owner's/);
  });

  it("answers the owner", async () => {
    await expect(handlers["agenda.today"]({}, owner)).resolves.toEqual({ ok: true });
  });
});
