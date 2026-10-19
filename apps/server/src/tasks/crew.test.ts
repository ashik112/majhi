import { basename } from "node:path";
import type { AccountUsage, RoomItem, Task, TeamPlan } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { Turn } from "../testing/fakeSession.ts";
import { until } from "../testing/until.ts";
import { taskWorld, type World } from "../testing/world.ts";

/**
 * Lead and workers (workflow reset, step 1b), driven through the fake agent's script mode: nobody spends a
 * token. Acme has a lead on Codex and two workers on their own Claude accounts. A script says what one agent
 * does on each of its turns; the lead records its plan from its first turn, as `record_plan` does.
 */

let w: World;
/** The server's clock for agent runs: moved forward to let a limit pass. */
let clock = new Date("2026-10-19T12:00:00.000Z");
/** Lets held turns end, so cleanup does not wait for them. */
let release: () => void = () => undefined;
afterEach(async () => {
  release();
  release = () => undefined;
  await w?.cleanup();
});

const NEVER_MS = 3_600_000;
type Say = (turn: Turn, n: number) => Promise<string | undefined> | string | undefined;
const LIMIT = new Error("You've hit your usage limit. Try again in 2 hours.");
const usage = (usedPct: number): AccountUsage => ({
  window: { usedPct, resetsAt: "2099-01-01T00:00:00.000Z" },
  models: [],
  estimated: false,
  updatedAt: "2026-10-19T12:00:00.000Z",
});

const STEPS = (...who: string[]) => who.map((id, i) => ({ who: id, what: `Step ${i + 1} of the work` }));
const plan = (...who: string[]): TeamPlan => ({
  steps: STEPS(...who),
  why: "Cheapest split.",
  how: ["builders"],
});

async function must(name: string, body: unknown): Promise<void> {
  const res = await w.h.cmd(name, body);
  if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
}

/**
 * Acme with a lead (Codex), a worker (`acme-builder`, Claude) and a second worker (`acme-w2`, Claude on
 * another account). `review`: the workspace asks for a review before the owner. `usages`: what each account
 * has used of its window, by agent, so one has more headroom than the other.
 */
async function crewWorld(
  scripts: Record<string, Say>,
  options: { review?: boolean; usages?: Record<string, number>; reviewer?: boolean } = {},
) {
  clock = new Date("2026-10-19T12:00:00.000Z");
  w = await taskWorld({ idleWatchMs: NEVER_MS, runClock: () => clock });
  await must("accounts.create", { id: "codex-acme", tool: "codex", org: "acme", auth: "login" });
  await must("agents.create", {
    id: "acme-lead",
    frontmatter: { scope: "acme", role: "Lead", account: "codex-acme", perms: ["edit", "shell"] },
    instructions: "Plan and delegate.\n",
  });
  await must("accounts.create", { id: "claude-acme-2", tool: "claude", org: "acme", auth: "login" });
  await must("agents.create", {
    id: "acme-w2",
    frontmatter: {
      scope: "acme",
      role: options.reviewer === true ? "Reviewer" : "Builder",
      account: "claude-acme-2",
      perms: ["edit", "shell"],
    },
    instructions: "Build or review.\n",
  });
  await must("orgs.update", { id: "acme", rooms: { review_before_owner: options.review === true } });

  const agentOf: Record<string, string> = {
    "codex-acme": "acme-lead",
    "claude-acme": "acme-builder",
    "claude-acme-2": "acme-w2",
  };
  const accountOf = Object.fromEntries(Object.entries(agentOf).map(([a, g]) => [g, a]));
  const prompts: Record<string, string[]> = {};
  const { h } = w;
  h.runtime.onSession = (session, start) => {
    if (start.scratch) return;
    const agent = agentOf[basename(start.account.home)] ?? "unknown";
    session.script = async (turn) => {
      const list = prompts[agent] ?? [];
      prompts[agent] = list;
      list.push(turn.text);
      const say = scripts[agent];
      const text = say === undefined ? "ok" : await say(turn, list.length);
      if (text !== undefined) turn.emit({ type: "text", messageId: `m${list.length}`, text });
      return "end_turn";
    };
  };
  // Each account's own usage, so headroom differs.
  const used = options.usages ?? {};
  h.runtime.readUsage = async (account) => {
    const agent = agentOf[basename(account.home)];
    return agent === undefined || used[agent] === undefined ? undefined : usage(used[agent]);
  };
  for (const agent of Object.keys(used))
    await w.h.majhi.services.accounts.usage(accountOf[agent] ?? "", true);

  await must("tasks.create", {
    text: "export orders from api",
    repos: [{ project: "acme-api" }],
    team: ["acme-lead", "acme-builder", "acme-w2"],
    start: false,
  });
  return { prompts, services: h.majhi.services };
}

const planOf = (): TeamPlan => {
  const row = w.h.majhi.services.store.plans.forTask("ACM-1").at(-1);
  if (row === undefined) throw new Error("no plan recorded");
  return row.plan;
};
const task = (id = "ACM-1") => w.h.majhi.services.store.tasks.get(id) as Task;
const lines = async (id = "ACM-1"): Promise<string[]> =>
  ((await w.h.cmd("room.items", { task: id, limit: 200 })).body.items as RoomItem[]).flatMap((i) =>
    i.type === "system" ? [i.text] : i.type === "paused" ? [i.why ?? ""] : [],
  );

/** The lead's first turn: it records the plan, as `record_plan` does, and says so. */
const planning =
  (...who: string[]): Say =>
  async (_turn, n) => {
    if (n === 1) {
      await w.h.majhi.services.tasks.recordPlan("ACM-1", "acme-lead", plan(...who));
      return "Plan recorded.";
    }
    return undefined;
  };

describe("a worker that cannot run", () => {
  it("has its step finished by another agent from the last checkpoint", async () => {
    const { prompts, services } = await crewWorld({
      "acme-lead": planning("acme-builder", "acme-w2", "me"),
      "acme-builder": () => {
        throw LIMIT;
      },
      "acme-w2": (_t, n) => `Done with its work ${n}.`,
    });
    await must("tasks.start", { id: "ACM-1" });
    await services.runs.idle();

    // The worker's own account hit its limit on its only turn; the step finished on the other worker.
    expect(prompts["acme-builder"]).toHaveLength(1);
    expect(prompts["acme-w2"]).toHaveLength(2);
    const done = planOf().steps;
    expect(done.map((s) => s.status)).toEqual(["done", "done", "done"]);
    expect(done[0]).toMatchObject({ who: "acme-w2", result: "Done with its work 1." });
    expect(done[2]?.who).toBe("me");
    expect(await lines()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^@acme-builder hit its usage limit \(resets .+\)\. @acme-w2 takes its step from the checkpoint\.$/,
        ),
      ]),
    );
    expect(task().status).toBe("review");
  });
});

describe("a lead that cannot run", () => {
  it("is replaced by the worker with the most headroom, who carries on with the plan", async () => {
    const { prompts, services } = await crewWorld(
      {
        "acme-lead": async (turn, n) => {
          if (n === 1) return planning("me", "acme-builder", "me")(turn, n);
          throw LIMIT;
        },
        "acme-builder": (_t, n) => `Built ${n}.`,
        "acme-w2": (_t, n) => `Led ${n}.`,
      },
      // The first worker is nearly out; the second has most of its window left.
      { usages: { "acme-builder": 90, "acme-w2": 20 } },
    );
    await must("tasks.start", { id: "ACM-1" });
    await services.runs.idle();

    expect(task().team[0]).toBe("acme-w2");
    expect(task().team).toContain("acme-lead");
    expect(await lines()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^@acme-lead hit its usage limit .+@acme-w2, the worker with the most headroom, leads now/,
        ),
      ]),
    );
    const steps = planOf().steps;
    expect(steps.map((s) => s.status)).toEqual(["done", "done", "done"]);
    // Step 1 was the old lead's ("me"): the new lead finished it, and it leads step 3 too.
    expect(prompts["acme-lead"]).toHaveLength(2);
    expect(steps[0]?.result).toBe("Led 1.");
    expect(steps[2]?.result).toBe("Led 2.");
  });
});

describe("every agent down", () => {
  it("pauses at the checkpoint with the exact fix, then resumes by itself on recovery, once", async () => {
    // Every account is at its limit until the limits reset.
    let reset = false;
    const down = (text: string) => () => {
      if (!reset) throw LIMIT;
      return text;
    };
    const { prompts, services } = await crewWorld({
      "acme-lead": async (turn, n) =>
        n === 1 ? planning("acme-builder", "me", "acme-w2")(turn, n) : down("Led.")(),
      "acme-builder": down("Built."),
      "acme-w2": down("Wrote docs."),
    });
    await must("tasks.start", { id: "ACM-1" });
    await services.runs.idle();

    await until(() => task().status === "paused");
    // Every account is at its limit: one hold, naming each account, and the reset time.
    expect(task()).toMatchObject({ status: "paused", pausedReason: "down" });
    const card = (await lines()).find((l) => l.startsWith("Every agent is down."));
    expect(card).toMatch(
      /^Every agent is down\. Wait for codex-acme \(resets [^)]+\), or wait for claude-acme \(resets [^)]+\), or wait for claude-acme-2 \(resets [^)]+\)\. It resumes by itself when one is back\.$/,
    );
    const before = Object.fromEntries(Object.entries(prompts).map(([a, p]) => [a, p.length]));

    // The limits reset. The task goes on by itself, from every place that notices an account is back at once.
    reset = true;
    clock = new Date(clock.getTime() + 3 * 3_600_000);
    await services.accounts.expireLimits();
    await Promise.all([services.budgets.lift(), services.tasks.resumeDown(), services.tasks.resumeDown()]);
    await services.runs.idle();
    await until(() => task().status === "review");

    // Each of the three steps ran once after the limits reset: the lead's step that was cut once again, then
    // the second step, then the worker's. No step ran twice, and the first worker never ran again.
    expect(planOf().steps.map((s) => s.status)).toEqual(["done", "done", "done"]);
    const ran = (agent: string) => (prompts[agent]?.length ?? 0) - (before[agent] ?? 0);
    expect([ran("acme-lead"), ran("acme-builder"), ran("acme-w2")]).toEqual([2, 0, 1]);
  });
});

describe("a step sent back twice", () => {
  it("stops, and the task waits for the owner with the reason", async () => {
    const sendBack =
      (reason: string): Say =>
      async () => {
        await w.h.majhi.services.tasks.crew.sendBack("ACM-1", "acme-w2", 1, reason);
        return "Sent it back.";
      };
    const { prompts, services } = await crewWorld(
      {
        "acme-lead": planning("acme-builder"),
        "acme-builder": (_t, n) => `Built it ${n}.`,
        "acme-w2": (turn, n) =>
          n === 1
            ? sendBack("Missing tests for the empty list.")(turn, n)
            : sendBack("Still no test for the empty list.")(turn, n),
      },
      // The workspace asks for a review before the owner: the plan ends with the reviewer's step.
      { review: true, reviewer: true },
    );
    await must("tasks.start", { id: "ACM-1" });
    await services.runs.idle();
    await until(() => task().status === "paused");

    // The builder built twice, the reviewer reviewed twice and sent the step back both times.
    expect(prompts["acme-builder"]).toHaveLength(2);
    expect(prompts["acme-w2"]).toHaveLength(2);
    expect(planOf().steps.map((s) => s.status)).toEqual(["stopped", "todo"]);
    expect(planOf().steps[0]).toMatchObject({ sentBack: 2, reason: "Still no test for the empty list." });
    expect(task()).toMatchObject({ status: "paused", pausedReason: "loop" });
    const why =
      "Step 1 was sent back 2 times and stopped. The last reason: Still no test for the empty list.";
    expect(await lines()).toContain(why);
    // Needs you shows it, with the reason.
    const needs = (await w.h.cmd("decisions.list")).body.decisions as { task?: string; title: string }[];
    expect(needs.filter((d) => d.task === "ACM-1").map((d) => d.title)).toEqual([`Stopped: ${why}`]);
  });
});

/** Two tasks of one agent with one running place. The first holds its turn until it is cancelled. */
async function preemptWorld() {
  w = await taskWorld();
  await must("settings.set", { limits: { tasks_running: 1 } });
  const prompts: Record<string, string[]> = {};
  w.h.runtime.onSession = (session, start) => {
    if (start.scratch) return;
    const slow = start.cwd.includes("slow-job");
    session.script = async (turn) => {
      const key = slow ? "slow" : "urgent";
      const list = prompts[key] ?? [];
      prompts[key] = list;
      list.push(turn.text);
      // The slow task's first turn runs until the owner cancels it, like a long piece of work.
      if (slow && list.length === 1) {
        await turn.untilCancelled();
        return "cancelled";
      }
      turn.emit({ type: "text", messageId: `m${list.length}`, text: "Done." });
      return "end_turn";
    };
  };
  await must("tasks.create", {
    text: "Slow job",
    name: "Slow job",
    repos: [{ project: "acme-api" }],
    start: true,
  });
  await until(() => (prompts.slow?.length ?? 0) === 1);
  await must("tasks.create", {
    text: "Urgent fix",
    name: "Urgent fix",
    repos: [{ project: "acme-api" }],
    start: false,
    priority: "urgent",
  });
  return { prompts, services: w.h.majhi.services };
}

describe("priority preemption", () => {
  it("pauses the lowest-priority running task for an urgent one, which resumes through the line without a second run", async () => {
    const { prompts, services } = await preemptWorld();
    expect(task("ACM-1").status).toBe("running");

    await must("tasks.start", { id: "ACM-2", priority: "urgent" });
    await until(() => task("ACM-2").status === "review");

    expect(await lines("ACM-1")).toContain(
      "Paused for acme-api · Urgent fix (urgent). Resumes when a slot frees.",
    );
    // The urgent task ran and finished in the place the slow one gave up; the slow one resumes by itself.
    await until(() => task("ACM-1").status === "review");
    await services.runs.idle();
    expect(prompts.urgent).toHaveLength(1);
    // Its first turn was cut at the preemption and it was resumed once: two prompts, never a third.
    expect(prompts.slow).toHaveLength(2);
  });

  it("is refused to the captain for a task the owner started, unless the owner asked", async () => {
    const { services } = await preemptWorld();
    await must("agents.create", {
      id: "boss",
      frontmatter: { scope: "root", role: "Lead", account: "claude-acme", perms: ["edit", "shell"] },
      instructions: "You are the captain.\n",
    });
    await must("boss.set", { id: "boss" });
    const captain = { actor: { kind: "agent", id: "boss" } };

    // Unasked: the urgent task waits in line and the owner's task keeps running.
    const unasked = await w.h.cmd("tasks.start", { id: "ACM-2", priority: "urgent" }, captain);
    expect(unasked.status).toBe(200);
    expect(task("ACM-1").status).toBe("running");
    expect(task("ACM-2").status).not.toBe("running");

    // The owner asked in the conversation: the captain may pause it.
    const asked = await w.h.cmd(
      "tasks.start",
      { id: "ACM-2", priority: "urgent", ownerAsked: true },
      captain,
    );
    expect(asked.status).toBe(200);
    expect(task("ACM-1")).toMatchObject({ status: "paused", pausedReason: "preempted" });
    await until(() => task("ACM-2").status === "review");
    await services.runs.idle();
  });
});
