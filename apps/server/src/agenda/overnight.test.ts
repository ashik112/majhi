import { describe, expect, it } from "vitest";
import { agendaHandlers } from "./handlers.ts";
import type { AgendaService } from "./service.ts";

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
  const _owner = as({ kind: "owner" });

  it("refuses an agent other than the captain on every command", async () => {
    await expect(handlers["agenda.today"]({}, agent)).rejects.toThrow();
    await expect(handlers["agenda.configure"]({ budgetMinutes: 30 }, agent)).rejects.toThrow();
    await expect(handlers["agenda.brief"]({}, agent)).rejects.toThrow();
    await expect(handlers["agenda.dismissBrief"]({ day: "2026-10-04" }, agent)).rejects.toThrow();
    expect(budgets).toEqual([]);
  });

  it("lets the captain read its lane's workspace and set the review time", async () => {
    await expect(handlers["agenda.today"]({}, captainInLane)).resolves.toEqual({
      org: "acme",
      withBrief: false,
    });
    await expect(handlers["agenda.today"]({ org: "globex" }, captainInLane)).rejects.toThrow();
    await expect(handlers["agenda.configure"]({ budgetMinutes: 30 }, captainInLane)).resolves.toEqual({
      org: "acme",
      withBrief: false,
    });
    expect(budgets).toEqual([30]);
  });
});
