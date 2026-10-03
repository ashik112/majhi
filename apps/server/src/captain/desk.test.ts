import type { AccountStatus, AutonomyEvent, AutonomyStatus, Task } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { RUNS } from "./authority-fixtures.ts";

/**
 * A day at the captain's desk, in two workspaces (Acme and Globex), with the fake agent runtime so no
 * token is spent. The owner turns Autonomous off and on, pauses a task by hand, an account signs out
 * and in again, an agent keeps asking the same thing, and the chores that may run while Autonomous
 * is off do. Everything is asserted on what the owner can see: task states, the log, the queue.
 */

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const must = (res: { status: number; body: unknown }) => {
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return res.body;
};

async function desk() {
  w = await bossWorld({ real: false });
  const { h } = w;
  const { autonomy, accounts, store, room, runs, captain } = h.majhi.services;

  // Every agent works until it is stopped, so a started task stays running.
  h.runtime.onSession = (session) => {
    session.script = async (turn) => {
      await turn.untilCancelled();
      return "cancelled";
    };
  };

  // A second workspace with its own account, agent and repo.
  must(await h.cmd("orgs.create", { id: "globex", name: "Globex", key: "GLX" }));
  must(await h.cmd("accounts.create", { id: "claude-globex", tool: "claude", org: "globex", auth: "login" }));
  must(
    await h.cmd("agents.create", {
      id: "globex-builder",
      frontmatter: {
        scope: "globex",
        role: "Builder",
        account: "claude-globex",
        model: "sonnet",
        effort: "high",
        perms: ["edit", "shell"],
      },
      instructions: "Build things.\n",
    }),
  );
  await w.addRepo("web");
  must(await h.cmd("projects.register", { id: "globex-web", org: "globex", path: "~/Work/web" }));
  must(
    await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS }, globex: { authority: RUNS } } }),
  );

  // The globex account's health, as the test sets it (a real sign-in needs a browser).
  let globexAccount: AccountStatus = "healthy";
  const listed = accounts.list.bind(accounts);
  vi.spyOn(accounts, "list").mockImplementation(async () =>
    (await listed()).map((a) => (a.id === "claude-globex" ? { ...a, status: globexAccount } : a)),
  );

  const lane = async (org: string) => {
    const chat = await autonomy.laneChat(org);
    if (chat === undefined) throw new Error(`no lane for ${org}`);
    return (tool: string, args: Record<string, unknown>) =>
      h.majhi.services.admin.call({ task: chat, agent: "boss" }, tool, { reason: "it is next", ...args });
  };
  const make = async (text: string, project: string, team: string[]) =>
    (must(await h.cmd("tasks.create", { text, repos: [{ project }], team, start: false })) as Task).id;
  const task = (id: string) => store.tasks.get(id);
  const status = async () => must(await h.cmd("autonomy.status")) as AutonomyStatus;
  const events = async () =>
    (must(await h.cmd("autonomy.events", { limit: 100 })) as { events: AutonomyEvent[] }).events.map(
      (e) => e.text,
    );
  return {
    h,
    autonomy,
    store,
    room,
    runs,
    captain,
    lane,
    make,
    task,
    status,
    events,
    setGlobexAccount: (s: AccountStatus) => {
      globexAccount = s;
    },
  };
}

describe("a day at the captain's desk", () => {
  it("resumes what Autonomous paused, leaves the owner's pause alone, and wakes on a signed-in account", async () => {
    const d = await desk();
    must(await d.h.cmd("autonomy.start"));
    const acme = await d.lane("acme");
    const globex = await d.lane("globex");

    // Acme has two slots: the owner's task runs first and is paused by hand, which frees its slot.
    const owned = await d.make("Tidy the changelog", "acme-api", ["acme-builder"]);
    const a1 = await d.make("Fix the login redirect", "acme-api", ["acme-builder"]);
    const a2 = await d.make("Add a health endpoint", "acme-api", ["acme-builder"]);
    const g1 = await d.make("Fix the invoice export", "globex-web", ["globex-builder"]);
    const start = async (lane: typeof acme, id: string) => {
      const res = await lane("majhi_tasks_start", { id });
      expect(res.isError ? res.text : "").toBe("");
    };
    await start(acme, owned);
    must(await d.h.cmd("tasks.stop", { id: owned }));
    expect(d.task(owned)).toMatchObject({ status: "paused", pausedReason: "owner" });

    // Two tasks on one repo run side by side, and one in Globex.
    await start(acme, a1);
    await start(acme, a2);
    await start(globex, g1);
    expect([a1, a2, g1].map((id) => d.task(id)?.status)).toEqual(["running", "running", "running"]);

    // Autonomous goes off: the running tasks pause because of it; the owner's task stays the owner's.
    must(await d.h.cmd("autonomy.stop", { how: "now" }));
    expect(d.task(a1)).toMatchObject({ status: "paused", pausedBy: "autonomy-off" });
    expect(d.task(a2)).toMatchObject({ status: "paused", pausedBy: "autonomy-off" });
    expect(d.task(g1)).toMatchObject({ status: "paused", pausedBy: "autonomy-off" });
    expect(d.task(owned)?.pausedBy).toBeUndefined();
    expect((await d.status()).stopped.sort()).toEqual([a1, a2, g1].sort());

    // Off: the captain starts nothing, but memory and cleanup still run.
    const { runner } = d.captain;
    expect(await runner.start("acme", "ship", "test")).toBeUndefined();
    expect(await runner.start("acme", "questions", "test")).toBeUndefined();
    expect(await runner.start("acme", "memory", "test")).toBe("done");
    expect(await runner.start("globex", "cleanup", "test")).toBe("done");

    // On again, leaving them paused: the captain resumes them itself, from the digest's list.
    must(await d.h.cmd("autonomy.start", { resumeStopped: false }));
    expect([a1, a2, g1].map((id) => d.task(id)?.status)).toEqual(["paused", "paused", "paused"]);
    const digestLine = (await d.status()).now.find((n) => n.task === a1)?.pause;
    expect(digestLine).toEqual({ label: "paused when Autonomous was turned off", mayResume: true });
    expect((await acme("majhi_tasks_start", { id: a1 })).isError).toBe(false);
    expect((await acme("majhi_tasks_start", { id: a2 })).isError).toBe(false);
    expect((await globex("majhi_tasks_start", { id: g1 })).isError).toBe(false);
    expect([a1, a2, g1].map((id) => d.task(id)?.status)).toEqual(["running", "running", "running"]);

    // The owner's pause is refused with one line, and the task is still paused.
    expect(await acme("majhi_tasks_start", { id: owned })).toEqual({
      isError: true,
      text: `Refused: the owner paused ${owned}, so it stays paused. If it should go on, leave it as a decision for the owner.`,
    });
    expect(d.task(owned)?.status).toBe("paused");

    // A Globex task stopped on a sign-in: the captain cannot resume it while the account is signed out,
    // plans around the account instead, and is woken when it works again.
    const g2 = await d.make("Add the VAT field", "globex-web", ["globex-builder"]);
    d.store.tasks.setStatus(g2, "paused", "signed-out", new Date().toISOString());
    d.setGlobexAccount("needs-login");
    const refused = await globex("majhi_tasks_start", { id: g2 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("claude-globex is signed out");
    const plan = await globex("majhi_autonomy_plan", {
      items: [
        {
          title: "Resume the VAT field",
          task: g2,
          why: "Its account needs a new sign-in",
          waitFor: { account: "claude-globex", state: "signed-in" },
        },
      ],
    });
    expect(plan.isError).toBe(false);
    await d.autonomy.sweepNow();
    expect((await d.status()).queue[0]?.readyAt).toBeUndefined();

    d.setGlobexAccount("healthy");
    await d.autonomy.sweepNow();
    expect((await d.status()).queue[0]?.readyAt).toBeDefined();
    expect(await d.events()).toContain(`claude-globex is signed in again: ${g2} can resume`);
    expect((await globex("majhi_tasks_start", { id: g2 })).isError).toBe(false);
    expect(d.task(g2)?.status).toBe("running");

    // The same belief, planned again now that the account works, is refused as stale.
    const stale = await globex("majhi_autonomy_plan", {
      items: [
        {
          title: "Resume the VAT field",
          task: g2,
          why: "Its account needs a new sign-in",
          waitFor: { account: "claude-globex", state: "signed-in" },
        },
      ],
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("claude-globex is signed in right now");
  });

  it("catches an agent that keeps asking the same thing, and raises a capped chore on the owner's word", async () => {
    const d = await desk();
    must(await d.h.cmd("autonomy.start"));
    const globex = await d.lane("globex");
    const g1 = await d.make("Fix the invoice export", "globex-web", ["globex-builder"]);
    const told: string[] = [];
    d.runs.notify = (_task, agent, text) => {
      told.push(`${agent}: ${text}`);
    };

    // The agent asks the same question five times; the captain answers the first and no more.
    const outcomes: boolean[] = [];
    for (let i = 1; i <= 5; i++) {
      d.room.post(g1, `q${i}`, {
        type: "choice",
        agent: "globex-builder",
        question: "Should I go on with the export?",
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
        state: "pending",
      });
      const res = await globex("majhi_autonomy_answer", { task: g1, item: `q${i}`, option: "yes" });
      outcomes.push(res.isError);
      if (i > 1) {
        expect(res.text).toBe(
          `@globex-builder keeps asking in ${g1} (2 times in 10 minutes); it may be stuck. It is left for the owner. Do not answer it.`,
        );
      }
    }
    expect(outcomes).toEqual([false, true, true, true, true]);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("do not ask it again");

    // The ship chore reaches its daily cap: the owner is asked, and "Raise for today" runs it again.
    const repo = d.captain.repo;
    const ws = await d.captain.status();
    const day = ws.day;
    for (let i = 0; i < 5; i++) {
      repo.addAction({
        key: `ship:seed:${i}`,
        org: "globex",
        chore: "ship",
        day,
        at: new Date().toISOString(),
        text: `Shipped GLX-${i + 40}`,
        reason: "seed",
        outcome: "done",
      });
    }
    d.store.tasks.setStatus(g1, "review", undefined, new Date().toISOString());
    expect(await d.captain.runner.start("globex", "ship", "ready for review")).toBe("capped");
    const asks = (await d.captain.asks()).asks;
    expect(asks).toEqual([
      expect.objectContaining({
        org: "globex",
        chore: "ship",
        text: "Globex: the captain shipped its 5 tasks for today. Raise the limit for today?",
      }),
    ]);
    await d.captain.answerCap("globex", "ship", "raise");
    expect(repo.capRaised("globex", "ship", day)).toBe(true);
    expect((await d.captain.asks()).asks).toEqual([]);
  });
});
