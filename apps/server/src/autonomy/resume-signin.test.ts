import type { AccountStatus, Task } from "@majhi/shared";
import { afterEach, expect, it, vi } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { seedStatus } from "../testing/status.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

it("the captain resumes a task paused on a sign-in once the account is healthy again", async () => {
  w = await bossWorld({ real: false });
  const { h } = w;
  const { autonomy, accounts, store } = h.majhi.services;
  h.runtime.onSession = (session) => {
    session.script = async (turn) => {
      await turn.untilCancelled();
      return "cancelled";
    };
  };
  expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } })).status).toBe(200);
  expect((await h.cmd("autonomy.start")).status).toBe(200);
  const chat = await autonomy.laneChat("acme");
  if (chat === undefined) throw new Error("no lane for Acme");
  const call = (tool: string, args: Record<string, unknown>) =>
    h.majhi.services.admin.call({ task: chat, agent: "boss" }, tool, { reason: "it is next", ...args });

  let health: AccountStatus = "needs-login";
  const listed = accounts.list.bind(accounts);
  vi.spyOn(accounts, "list").mockImplementation(async () =>
    (await listed()).map((a) => (a.id === "claude-acme" ? { ...a, status: health } : a)),
  );

  const made = await h.cmd("tasks.create", {
    text: "Add the VAT field",
    repos: [{ project: "acme-api" }],
    start: false,
  });
  const id = (made.body as Task).id;
  seedStatus(store, id, "paused", "signed-out", new Date().toISOString());

  const refused = await call("majhi_tasks_start", { id });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("is signed out");

  health = "healthy";
  await autonomy.sweepNow();
  const res = await call("majhi_tasks_start", { id });
  expect(res.isError).toBe(false);
  expect(store.tasks.get(id)?.status).toBe("running");
});
