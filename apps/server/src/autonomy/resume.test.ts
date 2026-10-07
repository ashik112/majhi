import type { AccountStatus, PausedBy, PausedReason, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ASK, RUNS } from "../captain/authority-fixtures.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { resumeRefusal } from "./resume.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

describe("which paused tasks the captain may resume", () => {
  const paused = (pausedReason: PausedReason | undefined, pausedBy?: PausedBy) => ({
    id: "ACM-1",
    status: "paused" as const,
    pausedReason,
    pausedBy,
  });
  const account = (status: AccountStatus) => ({ accounts: [{ id: "claude-acme", status }] });

  it("resumes what the captain or the Autonomous switch paused, whatever the reason said", () => {
    expect(resumeRefusal(paused("owner", "autonomy-off"), account("healthy"))).toBeUndefined();
    expect(resumeRefusal(paused("owner", "captain"), account("healthy"))).toBeUndefined();
  });

  it("never resumes what the owner paused, or what waits for the owner", () => {
    expect(resumeRefusal(paused("owner"), account("healthy"))).toBe(
      "Refused: the owner paused ACM-1, so it stays paused. If it should go on, leave it as a decision for the owner.",
    );
    expect(resumeRefusal(paused(undefined), account("healthy"))).toContain("the owner paused ACM-1");
    expect(resumeRefusal(paused("blocked"), account("healthy"))).toContain("it is blocked");
    expect(resumeRefusal(paused("loop"), account("healthy"))).toContain("going in circles");
  });

  it("resumes a limit, sign-in or offline pause only once its cause is gone", () => {
    expect(resumeRefusal(paused("limit"), account("at-limit"))).toContain("claude-acme is at its limit");
    expect(resumeRefusal(paused("limit"), { accounts: [], budgetHold: "Acme reached its cap" })).toContain(
      "Acme reached its cap",
    );
    expect(resumeRefusal(paused("limit"), account("healthy"))).toBeUndefined();
    expect(resumeRefusal(paused("signed-out"), account("needs-login"))).toContain(
      "claude-acme is signed out",
    );
    expect(resumeRefusal(paused("signed-out"), account("healthy"))).toBeUndefined();
    expect(resumeRefusal(paused("offline"), account("unreachable"))).toContain("cannot be reached");
    expect(resumeRefusal(paused("offline"), account("healthy"))).toBeUndefined();
    expect(resumeRefusal(paused("error"), account("needs-login"))).toContain("not working now");
    expect(resumeRefusal(paused("error"), account("healthy"))).toBeUndefined();
  });
});

/** Acme set to "Runs it", Autonomous on, the captain calling from Acme's lane. */
async function on() {
  w = await bossWorld({ real: false });
  const { h } = w;
  expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } })).status).toBe(200);
  expect((await h.cmd("autonomy.start")).status).toBe(200);
  const chat = await h.majhi.services.autonomy.laneChat("acme");
  if (chat === undefined) throw new Error("no lane for Acme");
  const call = (tool: string, args: Record<string, unknown>) =>
    h.majhi.services.admin.call({ task: chat, agent: "boss" }, tool, { reason: "it is next", ...args });
  const made = await h.cmd("tasks.create", {
    text: "Fix the typo on the login page",
    repos: [{ project: "acme-api" }],
    start: false,
  });
  const id = (made.body as Task).id;
  const task = () => h.majhi.services.store.tasks.get(id);
  return { h, call, id, task };
}

describe("the captain resuming paused tasks", () => {
  it("refuses a task the owner paused, with one line, and leaves it paused", async () => {
    const t = await on();
    expect((await t.call("majhi_tasks_start", { id: t.id })).isError).toBe(false);
    expect((await t.h.cmd("tasks.stop", { id: t.id })).status).toBe(200);
    expect(t.task()).toMatchObject({ status: "paused", pausedReason: "owner" });
    expect(t.task()?.pausedBy).toBeUndefined();

    const res = await t.call("majhi_tasks_start", { id: t.id });
    expect(res).toEqual({
      isError: true,
      text: `Refused: the owner paused ${t.id}, so it stays paused. If it should go on, leave it as a decision for the owner.`,
    });
    expect(t.task()?.status).toBe("paused");
  });

  it("keeps to the workspace's authority: on Ask me it does not resume", async () => {
    const t = await on();
    expect((await t.call("majhi_tasks_start", { id: t.id })).isError).toBe(false);
    expect((await t.call("majhi_tasks_stop", { id: t.id })).isError).toBe(false);
    expect((await t.h.cmd("autonomy.configure", { orgs: { acme: { authority: ASK } } })).status).toBe(200);
    const res = await t.call("majhi_tasks_start", { id: t.id });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/^Refused: /);
    expect(t.task()?.status).toBe("paused");
  });
});
