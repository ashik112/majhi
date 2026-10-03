import type { RoomItem, Task } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
import { capacityOf } from "../runs/limits.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await w?.cleanup();
  w = undefined;
});

/** Acme with two Claude accounts, one agent on each, and the captain in Acme's lane. */
async function staffed() {
  w = await bossWorld({ real: false });
  const { h } = w;
  const must = async (name: string, body: unknown) => {
    const res = await h.cmd(name, body);
    if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
  };
  await must("accounts.create", { id: "claude-acme-2", tool: "claude", org: "acme", auth: "login" });
  await must("agents.create", {
    id: "acme-other",
    frontmatter: { scope: "acme", role: "Builder", account: "claude-acme-2", perms: ["edit", "shell"] },
    instructions: "Build.\n",
  });
  await must("autonomy.configure", { orgs: { acme: { authority: RUNS } } });
  await must("autonomy.start", {});
  const chat = await h.majhi.services.autonomy.laneChat("acme");
  if (chat === undefined) throw new Error("no lane for Acme");
  const call = (tool: string, args: Record<string, unknown>) =>
    h.majhi.services.admin.call({ task: chat, agent: "boss" }, tool, { reason: "it is next", ...args });
  /** The first account has both its slots held; the second is idle. */
  vi.spyOn(h.majhi.services.runs, "capacity").mockImplementation(async (accounts = []) =>
    capacityOf(
      { holders: [{ account: "claude-acme" }, { account: "claude-acme" }], waiting: [] },
      { agents_max: 6, per_account: 2 },
      accounts,
    ),
  );
  const room = async (task: string) =>
    ((await h.cmd("room.items", { task, limit: 200 })).body.items as RoomItem[]).flatMap((i) =>
      i.type === "system" ? [i.text] : [],
    );
  return { h, call, room };
}

describe("the captain staffs a task that names no team", () => {
  it("puts the agent on the idle account in charge, says why in the room, and offers the proposal as a tool", async () => {
    const t = await staffed();
    const proposal = await t.call("majhi_tasks_staff", {
      text: "Add a health endpoint",
      repos: [{ project: "acme-api" }],
    });
    expect(proposal.isError).toBe(false);
    expect(JSON.parse(proposal.text)).toMatchObject({ lead: "acme-other", team: ["acme-other"] });

    const made = await t.call("majhi_tasks_create", {
      text: "Add a health endpoint",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    expect(made.isError).toBe(false);
    const task = t.h.majhi.services.store.tasks.list(false).find((s) => s.title === "Add a health endpoint");
    expect(task?.team).toEqual(["acme-other"]);
    const line = (await t.room(task?.id ?? "")).find((l) => l.startsWith("Team: "));
    expect(line).toContain("@acme-other leads on claude-acme-2");
    expect(line).toContain("free slot");
  });

  it("keeps a team the captain names", async () => {
    const t = await staffed();
    const made = await t.call("majhi_tasks_create", {
      text: "Tidy the logs",
      repos: [{ project: "acme-api" }],
      team: ["acme-builder"],
      start: false,
    });
    expect(made.isError).toBe(false);
    const task = t.h.majhi.services.store.tasks.list(false).find((s) => s.title === "Tidy the logs") as
      | Pick<Task, "team">
      | undefined;
    expect(task?.team).toEqual(["acme-builder"]);
  });
});
