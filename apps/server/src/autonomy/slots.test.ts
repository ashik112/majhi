import type { Task } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ASK, RUNS, TIDY } from "../captain/authority-fixtures.ts";
import { capacityOf } from "../runs/limits.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await w?.cleanup();
  w = undefined;
});

/** Acme set to "Runs it" and autonomous mode on; the captain calls from Acme's lane. */
async function on() {
  w = await bossWorld({ real: false });
  const { h } = w;
  const autonomy = h.majhi.services.autonomy;
  expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } })).status).toBe(200);
  expect((await h.cmd("autonomy.start")).status).toBe(200);
  const chat = await autonomy.laneChat("acme");
  if (chat === undefined) throw new Error("no lane for Acme");
  const call = (tool: string, args: Record<string, unknown>) =>
    h.majhi.services.admin.call({ task: chat, agent: "boss" }, tool, { reason: "it is next", ...args });
  const ownerTask = async (text: string): Promise<string> => {
    const made = await h.cmd("tasks.create", { text, repos: [{ project: "acme-api" }], start: false });
    expect(made.status).toBe(200);
    return (made.body as Task).id;
  };
  const runs = h.majhi.services.runs;
  /** Every account asked about has both its slots held and three starts waiting. */
  const full = () =>
    vi.spyOn(runs, "capacity").mockImplementation(async (accounts = []) =>
      capacityOf(
        {
          holders: accounts.flatMap((account) => [{ account }, { account }]),
          waiting: accounts.flatMap((account) => [{ account }, { account }, { account }]),
        },
        { agents_max: 6, per_account: 2 },
        accounts,
      ),
    );
  return { h, call, ownerTask, full, status: (id: string) => h.majhi.services.store.tasks.get(id)?.status };
}

describe("the captain and free agent slots", () => {
  it("refuses the captain's start with one line when no slot is free, starts it when one is, and never holds the owner's start", async () => {
    const t = await on();
    const first = await t.ownerTask("Fix the typo on the login page");
    const spy = t.full();
    const no = await t.call("majhi_tasks_start", { id: first });
    const account = spy.mock.calls[0]?.[0]?.[0];
    expect(account).toBeDefined();
    expect(no).toEqual({
      isError: true,
      text: `No free slot on ${account}: 2 of 2 in use, 3 waiting. ${first} waits.`,
    });
    expect(t.status(first)).toBe("inbox");

    // A task it files with start stays in the backlog.
    const filed = await t.call("majhi_tasks_create", {
      text: "Add a CSV export",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    expect(filed.isError).toBe(false);
    expect(filed.text).toContain(
      `No free slot on ${account}: 2 of 2 in use, 3 waiting. Filed without starting`,
    );
    const made = t.h.majhi.services.store.tasks.list(false).find((task) => task.title === "Add a CSV export");
    expect(made?.status).toBe("inbox");

    // The owner's own start goes through while every slot is taken.
    const mine = await t.ownerTask("Update the README");
    expect((await t.h.cmd("tasks.start", { id: mine })).status).toBe(200);
    expect(t.status(mine)).toBe("running");

    // A slot frees up (and the owner's task no longer holds the repo): the captain's start goes.
    spy.mockRestore();
    expect((await t.h.cmd("tasks.stop", { id: mine })).status).toBe(200);
    const yes = await t.call("majhi_tasks_start", { id: first });
    expect(yes.text).not.toContain("No free slot");
    expect(t.status(first)).toBe("running");
  });
});

describe("the captain and the repo rule", () => {
  it("keeps a second task on the same repo and base in the backlog, allows disjoint areas, and never blocks the owner", async () => {
    const t = await on();
    const running = await t.ownerTask("Rework login in src/auth/login.ts");
    expect((await t.h.cmd("tasks.start", { id: running })).status).toBe(200);
    const same = await t.ownerTask("Fix a typo in src/auth/session.ts");
    const no = await t.call("majhi_tasks_start", { id: same });
    expect(no.isError).toBe(true);
    expect(no.text).toMatch(
      new RegExp(
        `^Not starting ${same}: ${running} is already changing acme-api on \\S+\\. ${same} waits\\.$`,
      ),
    );
    expect(t.status(same)).toBe("inbox");

    // A new task whose plan is not known yet runs beside it: its own worktree keeps them apart.
    const filed = await t.call("majhi_tasks_create", {
      text: "Tidy the login form",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    expect(filed.text).not.toContain("Not starting");

    // Plans naming different top-level areas may run together.
    const docs = await t.ownerTask("Update the setup guide in docs/guide.md");
    const yes = await t.call("majhi_tasks_start", { id: docs });
    // Not held by the repo rule (it may still wait for a free slot).
    expect(yes.text).not.toContain("already changing");

    // The owner's own start is never blocked.
    expect((await t.h.cmd("tasks.start", { id: same })).status).toBe(200);
    expect(t.status(same)).toBe("running");
  });
});
