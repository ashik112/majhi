import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { Turn } from "../testing/fakeSession.ts";
import { git } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { VERDICT_ASK } from "./handoff.ts";

let w: World;
afterEach(() => w?.cleanup());

/** What one agent does on each of its turns, in order. Past the list it says "ok". */
type Turns = ((turn: Turn) => Promise<string>)[];

/**
 * Acme with a lead on Codex, the world's builder on Claude and a reviewer on a second Claude
 * account, so each session can be told apart by its account home. Every agent runs its own script.
 */
async function teamWorld(
  scripts: Record<string, Turns>,
  options: { reviewer?: boolean; lead?: boolean } = {},
) {
  w = await taskWorld();
  const { h } = w;
  const must = async (name: string, body: unknown) => {
    const res = await h.cmd(name, body);
    if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
  };
  const agentOf: Record<string, string> = { "claude-acme": "acme-builder" };
  if (options.lead !== false) {
    await must("accounts.create", { id: "codex-acme", tool: "codex", org: "acme", auth: "login" });
    await must("agents.create", {
      id: "acme-lead",
      frontmatter: { scope: "acme", role: "Lead", account: "codex-acme", perms: ["edit", "shell"] },
      instructions: "Plan and delegate.\n",
    });
    agentOf["codex-acme"] = "acme-lead";
  }
  if (options.reviewer !== false) {
    await must("accounts.create", { id: "claude-acme-2", tool: "claude", org: "acme", auth: "login" });
    await must("agents.create", {
      id: "acme-reviewer",
      frontmatter: { scope: "acme", role: "Reviewer", account: "claude-acme-2", perms: ["shell"] },
      instructions: "Review carefully.\n",
    });
    agentOf["claude-acme-2"] = "acme-reviewer";
  }
  const prompts: Record<string, string[]> = {};
  /** The same prompts with every text block, for what rides after the first one. */
  const full: Record<string, string[]> = {};
  h.runtime.onSession = (session, start) => {
    // A decision stand-in's session is not the agent's turn.
    if (start.scratch) return;
    const agent = agentOf[basename(start.account.home)] ?? "unknown";
    session.script = async (turn) => {
      const list = prompts[agent] ?? [];
      prompts[agent] = list;
      list.push(turn.text);
      const texts = full[agent] ?? [];
      full[agent] = texts;
      texts.push(turn.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n"));
      const step = scripts[agent]?.[list.length - 1];
      const text = step === undefined ? "ok" : await step(turn);
      turn.emit({ type: "text", messageId: `m${list.length}`, text });
      return "end_turn";
    };
  };
  return { h, prompts, full };
}

const say = (text: string) => async () => text;

async function items(task: string): Promise<RoomItem[]> {
  const page = await w.h.cmd("room.items", { task, limit: 500 });
  return [...(page.body.items as RoomItem[])].sort((a, b) => a.seq - b.seq);
}

async function handoffs(task: string): Promise<string[]> {
  return (await items(task)).flatMap((i) => (i.type === "handoff" ? [`${i.from}>${i.to} (${i.via})`] : []));
}

async function systemTexts(task: string): Promise<string[]> {
  return (await items(task)).flatMap((i) => (i.type === "system" ? [i.text] : []));
}

/**
 * Polls until `check` holds. The deadline is wall-clock, not a poll count: a turn ending runs git
 * and the decision chain before it wakes the next agent, which takes seconds on a busy machine.
 * Kept under the test timeout so a real hang still names what it waited for.
 */
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Nobody works and nothing waits in any queue: no further agent turn is scheduled. */
async function settled(task: string, agents: readonly string[]): Promise<void> {
  const { runs, store } = w.h.majhi.services;
  await runs.idle(task);
  expect(runs.working(task)).toEqual([]);
  for (const a of agents) expect(store.room.queuedFor(task, a)).toEqual([]);
}

const status = async (task: string) => (await w.h.cmd("tasks.get", { id: task })).body.status as string;

describe("lead, builder and reviewer on different tools", () => {
  it("complete a task together, with a fix round when the reviewer catches an issue", async () => {
    const worktree = () => join(w.taskDir("ACM-1"), "acme-api");
    const { h, prompts } = await teamWorld({
      "acme-lead": [say("Plan: add GET /health. @acme-builder please build it in api, with a test.")],
      "acme-builder": [
        async () => {
          await writeFile(join(worktree(), "health.ts"), "export const health = () => 'ok';\n");
          return "Added the handler. @acme-reviewer please review.";
        },
        async () => {
          await writeFile(join(worktree(), "health.test.ts"), "test('health', () => {});\n");
          return "Added the test. @acme-reviewer please look again.";
        },
      ],
      "acme-reviewer": [
        say("The handler has no test. @acme-builder CHANGES NEEDED: add a test for it."),
        say("The test is there now. APPROVED"),
      ],
    });
    const res = await h.cmd("tasks.create", {
      text: "add a health endpoint to api",
      repos: [{ project: "acme-api" }],
      team: ["acme-lead", "acme-builder", "acme-reviewer"],
      start: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("lead");
    await until(async () => (await status("ACM-1")) === "review", "review");

    expect(await handoffs("ACM-1")).toEqual([
      "acme-lead>acme-builder (mention)",
      "acme-builder>acme-reviewer (mention)",
      "acme-reviewer>acme-builder (mention)",
      "acme-builder>acme-reviewer (mention)",
    ]);
    expect(await systemTexts("ACM-1")).toContain("@acme-reviewer approved the work. Over to you.");

    // Only the lead got the brief; the others got handoff prompts with the message and the state.
    expect(prompts["acme-lead"]?.[0]).toMatch(/Read TASK.md/);
    const builderFix = prompts["acme-builder"]?.[1] ?? "";
    expect(builderFix).toContain("@acme-reviewer handed this to you");
    expect(builderFix).toContain("> The handler has no test.");
    expect(builderFix).toMatch(/Changes so far:[\s\S]*health\.ts/);
    expect(prompts["acme-builder"]?.[0]).toContain("First read TASK.md");
    expect(prompts["acme-reviewer"]?.[0]).toContain(VERDICT_ASK);

    // Each tool ran in its own session, and the work is in checkpoints on the task branch.
    const tools = new Set(h.runtime.starts.map((s) => s.account.tool));
    expect([...tools].sort()).toEqual(["claude", "codex"]);
    const log = await git(worktree(), "log", "--format=%s");
    expect(log).toMatch(/wip\(ACM-1\): checkpoint/);
    expect(await git(worktree(), "ls-files")).toContain("health.test.ts");

    // TASK.md tells the team how to hand work on.
    const md = await readFile(join(w.taskDir("ACM-1"), "TASK.md"), "utf8");
    expect(md).toContain("## Team");
    expect(md).toContain("- @acme-reviewer (Reviewer)");
    expect(md).toContain("Mode: Lead delegates.");
  });
});

describe("the build and review loop", () => {
  it("alternates builder and reviewer without mentions until approval", async () => {
    const { h, prompts } = await teamWorld(
      {
        "acme-builder": [say("First version done."), say("Fixed the naming.")],
        "acme-reviewer": [say("CHANGES NEEDED: rename the handler."), say("APPROVED")],
      },
      { lead: false },
    );
    const res = await h.cmd("tasks.create", {
      text: "add a health endpoint to api",
      repos: [{ project: "acme-api" }],
      team: ["acme-builder", "acme-reviewer"],
      mode: "review-loop",
      start: true,
    });
    expect(res.status).toBe(200);
    await until(async () => (await status("ACM-1")) === "review", "review");
    expect(await handoffs("ACM-1")).toEqual([
      "acme-builder>acme-reviewer (review-loop)",
      "acme-reviewer>acme-builder (review-loop)",
      "acme-builder>acme-reviewer (review-loop)",
    ]);
    expect(prompts["acme-builder"]?.[1]).toContain("reviewed your work and asks for changes");
    expect(h.majhi.services.store.tasks.roomState("ACM-1").round).toBe(1);
  });
});

describe("the pipeline", () => {
  it("runs lead, builder and reviewer once each, in order, then hands to the owner", async () => {
    const { h, prompts } = await teamWorld({
      "acme-lead": [say("Plan: one route and a test.")],
      "acme-builder": [say("Built the route and the test.")],
      "acme-reviewer": [say("Checked. APPROVED")],
    });
    const res = await h.cmd("tasks.create", {
      text: "add a health endpoint to api",
      repos: [{ project: "acme-api" }],
      team: ["acme-reviewer", "acme-builder", "acme-lead"],
      mode: "pipeline",
      start: true,
    });
    expect(res.status).toBe(200);
    await until(async () => (await status("ACM-1")) === "review", "review");
    expect(await handoffs("ACM-1")).toEqual([
      "acme-lead>acme-builder (pipeline)",
      "acme-builder>acme-reviewer (pipeline)",
    ]);
    // The lead went first although the reviewer is first in the team: the pipeline goes by role.
    expect(prompts["acme-lead"]?.[0]).toMatch(/Read TASK.md/);
    expect(prompts["acme-reviewer"]).toHaveLength(1);
    expect(await systemTexts("ACM-1")).toContain("Every step of the pipeline ran. Over to you.");
  });
});

describe("the loop guard", () => {
  it("wakes the lead once when agents loop, then pauses with reason loop, and an owner message resets it", async () => {
    const ping = say("@acme-reviewer your turn.");
    const pong = say("@acme-builder your turn.");
    const { h } = await teamWorld(
      { "acme-builder": Array(20).fill(ping), "acme-reviewer": Array(20).fill(pong) },
      { lead: false },
    );
    expect((await h.cmd("settings.set", { rooms: { max_agent_turns: 3 } })).status).toBe(200);
    await h.cmd("tasks.create", {
      text: "add a health endpoint to api",
      repos: [{ project: "acme-api" }],
      team: ["acme-builder", "acme-reviewer"],
      start: true,
    });
    await until(async () => (await status("ACM-1")) === "paused", "paused");
    await h.majhi.services.runs.idle("ACM-1");
    const task = (await h.cmd("tasks.get", { id: "ACM-1" })).body;
    expect(task.pausedReason).toBe("loop");
    // The first trip woke the lead (the team's first member) instead of pausing.
    expect(await handoffs("ACM-1")).toContain("majhi>acme-builder (guard)");
    expect((await systemTexts("ACM-1")).some((t) => t.startsWith("Agents went in circles"))).toBe(true);
    expect((await systemTexts("ACM-1")).some((t) => t.includes("more handoffs changed no files"))).toBe(true);

    const sent = await h.cmd("room.send", { task: "ACM-1", text: "carry on" });
    expect(sent.status).toBe(200);
    expect(sent.body.item.to).toBe("acme-builder");
    expect(h.majhi.services.store.tasks.roomState("ACM-1")).toMatchObject({ agentTurns: 0, nudged: false });
  });
});

describe("owner messages", () => {
  it("go to the lead without a mention, to every mentioned agent, and add a mentioned agent to the team", async () => {
    const { h, prompts } = await teamWorld({});
    await h.cmd("tasks.create", {
      text: "add a health endpoint to api",
      repos: [{ project: "acme-api" }],
      team: ["acme-lead"],
      start: true,
    });
    await until(async () => (await status("ACM-1")) === "review", "review");

    const toLead = await h.cmd("room.send", { task: "ACM-1", text: "what is the plan?" });
    expect(toLead.body.item.to).toBe("acme-lead");
    await until(async () => (await status("ACM-1")) === "review", "review again");

    const both = await h.cmd("room.send", { task: "ACM-1", text: "@acme-builder and @acme-lead, sync up" });
    expect(both.status).toBe(200);
    await until(() => (prompts["acme-builder"]?.length ?? 0) === 1, "builder prompt");
    const task = (await h.cmd("tasks.get", { id: "ACM-1" })).body;
    expect(task.team).toEqual(["acme-lead", "acme-builder"]);
    expect(await systemTexts("ACM-1")).toContain("Added @acme-builder (Builder) to the team.");
    expect(prompts["acme-builder"]?.[0]).toContain("sync up");
    await until(() => (prompts["acme-lead"]?.length ?? 0) === 3, "lead prompt");
  });

  it("cannot pull in an agent that may not work in the org", async () => {
    const { h } = await teamWorld({}, { lead: false, reviewer: false });
    await must(h, "orgs.create", { id: "globex", name: "Globex", key: "GLX" });
    await must(h, "accounts.create", { id: "claude-globex", tool: "claude", org: "globex", auth: "login" });
    await must(h, "agents.create", {
      id: "globex-builder",
      frontmatter: { scope: "globex", role: "Builder", account: "claude-globex" },
      instructions: "x\n",
    });
    await h.cmd("tasks.create", {
      text: "add a health endpoint to api",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    const res = await h.cmd("room.send", { task: "ACM-1", text: "@globex-builder help" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cannot work in "acme"/);
  });
});

describe("team editing", () => {
  it("adds, swaps, removes and sets a per-task model that the next session uses", async () => {
    const { h } = await teamWorld({});
    await h.cmd("tasks.create", {
      text: "add a health endpoint to api",
      repos: [{ project: "acme-api" }],
      team: ["acme-builder"],
      start: false,
    });
    expect((await h.cmd("team.add", { task: "ACM-1", agent: "acme-lead", lead: true })).body.team).toEqual([
      "acme-lead",
      "acme-builder",
    ]);
    expect(
      (await h.cmd("team.swap", { task: "ACM-1", agent: "acme-builder", with: "acme-reviewer" })).body.team,
    ).toEqual(["acme-lead", "acme-reviewer"]);
    const set = await h.cmd("team.set", { task: "ACM-1", agent: "acme-lead", model: "opus", effort: "high" });
    expect(set.body.overrides).toEqual({ "acme-lead": { model: "opus", effort: "high" } });
    expect((await h.cmd("team.remove", { task: "ACM-1", agent: "acme-reviewer" })).body.team).toEqual([
      "acme-lead",
    ]);
    expect((await h.cmd("team.remove", { task: "ACM-1", agent: "acme-lead" })).status).toBe(409);

    await h.cmd("tasks.start", { id: "ACM-1" });
    await until(() => h.runtime.starts.length > 0, "session");
    expect(h.runtime.starts[0]).toMatchObject({ model: "opus", effort: "high" });
    const cleared = await h.cmd("team.set", { task: "ACM-1", agent: "acme-lead", model: null, effort: null });
    expect(cleared.body.overrides).toEqual({});
  });

  it("hands a just-started lead's brief to the agent swapped into its place, which starts on it as the lead", async () => {
    const { h, prompts } = await teamWorld({
      // The lead is still on its brief when it is swapped out: its turn ends only with the cancel.
      "acme-lead": [
        async (turn) => {
          await turn.untilCancelled();
          return "never seen";
        },
      ],
      "acme-builder": [say("Read the brief and did the work.")],
    });
    await h.cmd("tasks.create", {
      text: "add a health endpoint to api",
      repos: [{ project: "acme-api" }],
      team: ["acme-lead"],
      start: true,
    });
    await until(() => (prompts["acme-lead"]?.length ?? 0) === 1, "lead's first turn");
    const swapped = await h.cmd("team.swap", { task: "ACM-1", agent: "acme-lead", with: "acme-builder" });
    expect(swapped.status).toBe(200);
    expect(swapped.body.team).toEqual(["acme-builder"]);

    // The replacement gets the brief the lead was working on, without anyone telling it.
    await until(() => (prompts["acme-builder"]?.length ?? 0) === 1, "replacement's turn");
    expect(prompts["acme-builder"]?.[0]).toMatch(/Read TASK.md/);
    expect(await systemTexts("ACM-1")).toContain(
      "@acme-builder (Lead) took @acme-lead's place. It carries on with what @acme-lead had pending.",
    );
    const md = await readFile(join(w.taskDir("ACM-1"), "TASK.md"), "utf8");
    expect(md).toContain("- @acme-builder (Lead)");
    await until(async () => (await status("ACM-1")) === "review", "review");
    expect(prompts["acme-lead"]).toHaveLength(1);
  });

  it("wakes nobody when the swapped agent had nothing pending", async () => {
    const { h, prompts } = await teamWorld({});
    await h.cmd("tasks.create", {
      text: "add a health endpoint to api",
      repos: [{ project: "acme-api" }],
      team: ["acme-lead", "acme-builder"],
      start: true,
    });
    await until(async () => (await status("ACM-1")) === "review", "review");
    const swapped = await h.cmd("team.swap", { task: "ACM-1", agent: "acme-builder", with: "acme-reviewer" });
    expect(swapped.body.team).toEqual(["acme-lead", "acme-reviewer"]);
    await settled("ACM-1", ["acme-lead", "acme-reviewer"]);
    expect(prompts["acme-reviewer"]).toBeUndefined();
    expect(await systemTexts("ACM-1")).toContain("@acme-reviewer (Reviewer) took @acme-builder's place.");
  });

  it("adds and removes with tasks.addAgent and tasks.removeAgent, never removing a working agent", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { h, prompts } = await teamWorld({
      "acme-reviewer": [
        async () => {
          await gate;
          return "looked";
        },
      ],
    });
    await h.cmd("tasks.create", {
      text: "add a health endpoint to api",
      repos: [{ project: "acme-api" }],
      team: ["acme-lead"],
      start: false,
    });
    expect((await h.cmd("tasks.addAgent", { id: "ACM-1", agent: "acme-builder" })).body.team).toEqual([
      "acme-lead",
      "acme-builder",
    ]);
    expect(
      (await h.cmd("tasks.addAgent", { id: "ACM-1", agent: "acme-reviewer", lead: true })).body.team,
    ).toEqual(["acme-reviewer", "acme-lead", "acme-builder"]);
    expect(
      (await items("ACM-1")).some((i) => i.type === "system" && /Added @acme-reviewer/.test(i.text)),
    ).toBe(true);

    // A message with no mention goes to the first agent; it stays on the team while it works.
    await h.cmd("room.send", { task: "ACM-1", text: "have a look" });
    await until(() => (prompts["acme-reviewer"]?.length ?? 0) === 1, "reviewer turn");
    const refused = await h.cmd("tasks.removeAgent", { id: "ACM-1", agent: "acme-reviewer" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/is working on ACM-1/);
    release();
    const working = async () =>
      ((await h.cmd("tasks.list", {})).body as { id: string; working: string[] }[]).find(
        (t) => t.id === "ACM-1",
      )?.working;
    await until(async () => (await working())?.length === 0, "idle");

    expect((await h.cmd("tasks.removeAgent", { id: "ACM-1", agent: "acme-reviewer" })).body.team).toEqual([
      "acme-lead",
      "acme-builder",
    ]);
    expect((await h.cmd("tasks.removeAgent", { id: "ACM-1", agent: "acme-reviewer" })).status).toBe(404);
  });
});

describe("idle messages", () => {
  it("wake no one when two agents post without a mention", async () => {
    const { h, prompts } = await teamWorld({
      "acme-lead": [say("@acme-builder and @acme-reviewer, look over the api and say what you find.")],
      "acme-builder": [say("Nothing to do for me here.")],
      "acme-reviewer": [say("Nothing to review yet, standing by.")],
    });
    await h.cmd("tasks.create", {
      text: "add a health endpoint to api",
      repos: [{ project: "acme-api" }],
      team: ["acme-lead", "acme-builder", "acme-reviewer"],
      start: true,
    });
    await until(() => (prompts["acme-reviewer"]?.length ?? 0) === 1, "reviewer turn");
    await until(() => (prompts["acme-builder"]?.length ?? 0) === 1, "builder turn");
    await settled("ACM-1", ["acme-lead", "acme-builder", "acme-reviewer"]);
    expect(await handoffs("ACM-1")).toEqual([
      "acme-lead>acme-builder (mention)",
      "acme-lead>acme-reviewer (mention)",
    ]);
    expect(prompts["acme-lead"]).toHaveLength(1);
  });

  it("do not wake the lead with a waiting reply while the owner has a question pending", async () => {
    const { h, prompts } = await teamWorld(
      {
        "acme-lead": [say("@acme-builder read the api first. @owner which port should /health use?")],
        "acme-builder": [say("Read it. Nothing for me until the owner answers. Standing by, @acme-lead.")],
      },
      { reviewer: false },
    );
    await h.cmd("tasks.create", {
      text: "add a health endpoint to api",
      repos: [{ project: "acme-api" }],
      team: ["acme-lead", "acme-builder"],
      start: true,
    });
    await until(() => (prompts["acme-builder"]?.length ?? 0) === 1, "builder turn");
    await settled("ACM-1", ["acme-lead", "acme-builder"]);
    expect(await handoffs("ACM-1")).toEqual(["acme-lead>acme-builder (mention)"]);
    expect(prompts["acme-lead"]).toHaveLength(1);
    // One question card: the waiting reply did not post another.
    expect((await items("ACM-1")).filter((i) => i.type === "owner-question")).toHaveLength(1);

    // The owner answers: the room runs again.
    await h.cmd("room.send", { task: "ACM-1", text: "port 8080" });
    await until(() => (prompts["acme-lead"]?.length ?? 0) === 2, "lead after the answer");
  });

  it("do not bring back or wake an agent the owner removed; the owner can add it again", async () => {
    const { h, prompts } = await teamWorld({
      "acme-builder": [say("@acme-reviewer please check the api.\n@acme-lead: you too, please.")],
    });
    await h.cmd("tasks.create", {
      text: "add a health endpoint to api",
      repos: [{ project: "acme-api" }],
      team: ["acme-lead", "acme-builder", "acme-reviewer"],
      start: false,
    });
    expect((await h.cmd("team.remove", { task: "ACM-1", agent: "acme-reviewer" })).status).toBe(200);
    await h.cmd("room.send", { task: "ACM-1", text: "@acme-builder take a look" });
    await until(() => (prompts["acme-lead"]?.length ?? 0) === 1, "lead turn");
    await settled("ACM-1", ["acme-lead", "acme-builder", "acme-reviewer"]);
    expect((await h.cmd("tasks.get", { id: "ACM-1" })).body.team).toEqual(["acme-lead", "acme-builder"]);
    expect(await handoffs("ACM-1")).toEqual(["acme-builder>acme-lead (mention)"]);
    expect(prompts["acme-reviewer"]).toBeUndefined();

    // The mention tool refuses it too.
    const coordinator = h.majhi.services.coordinator;
    await expect(
      coordinator.mention({ task: "ACM-1", agent: "acme-builder" }, "acme-reviewer", "check this"),
    ).rejects.toThrow(/Only the owner can add it back/);
    // TASK.md does not offer it.
    const md = await readFile(join(w.taskDir("ACM-1"), "TASK.md"), "utf8");
    expect(md).not.toMatch(/Could join[\s\S]*@acme-reviewer/);

    expect((await h.cmd("team.add", { task: "ACM-1", agent: "acme-reviewer" })).status).toBe(200);
    expect(h.majhi.services.store.tasks.roomState("ACM-1").removed).toEqual([]);
  });
});

describe("the mention tool", () => {
  it("hands work on once: the same turn's closing message does not wake that teammate again", async () => {
    const { h, prompts } = await teamWorld(
      {
        "acme-lead": [
          async () => {
            await h.majhi.services.coordinator.mention(
              { task: "ACM-1", agent: "acme-lead" },
              "acme-builder",
              "Build the health endpoint.",
            );
            return "Handed the build on. @acme-builder: please build the health endpoint.";
          },
        ],
        "acme-builder": [say("Built it.")],
      },
      { reviewer: false },
    );
    await h.cmd("tasks.create", {
      text: "add a health endpoint to api",
      repos: [{ project: "acme-api" }],
      team: ["acme-lead", "acme-builder"],
      start: true,
    });
    await until(() => (prompts["acme-builder"]?.length ?? 0) === 1, "builder turn");
    await settled("ACM-1", ["acme-lead", "acme-builder"]);
    expect(await handoffs("ACM-1")).toEqual(["acme-lead>acme-builder (tool)"]);
    expect(prompts["acme-builder"]).toHaveLength(1);
    // Nothing was left for the owner to answer: the lead handed the work on.
    expect((await items("ACM-1")).filter((i) => i.type === "owner-question")).toHaveLength(0);
  });
});

describe("worktree locks", () => {
  it("make a second editing agent wait for the first to finish in the same worktree", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { h, prompts } = await teamWorld(
      {
        "acme-lead": [
          async () => {
            await gate;
            return "done";
          },
        ],
        "acme-builder": [say("built")],
      },
      { reviewer: false },
    );
    await h.cmd("tasks.create", {
      text: "add a health endpoint to api",
      repos: [{ project: "acme-api" }],
      team: ["acme-lead", "acme-builder"],
      start: true,
    });
    await until(() => (prompts["acme-lead"]?.length ?? 0) === 1, "lead turn");
    await h.cmd("room.send", { task: "ACM-1", text: "@acme-builder start too" });
    const live = () => h.majhi.services.room.getLive("ACM-1", "acme-builder");
    await until(() => live()?.nowDoing === "Waiting for @acme-lead to finish in acme-api", "waiting");
    expect(prompts["acme-builder"]).toBeUndefined();
    release();
    await until(() => (prompts["acme-builder"]?.length ?? 0) === 1, "builder turn");
  });
});

describe("the default team", () => {
  it("is picked by the decision provider when several teams fit, with the decision recorded", async () => {
    const { h } = await teamWorld({});
    // The stand-in agent answers for Laya here; Laya itself is not connected in tests.
    expect(
      (await h.cmd("decisions.set", { order: ["acp", "rules"], acp_agent: "acme-builder" })).status,
    ).toBe(200);
    const standIn = h.runtime.onSession;
    h.runtime.onSession = (session, start) => {
      standIn?.(session, start);
      if (!start.scratch) return;
      session.script = async (turn) => {
        // The options are keyed: `full` is described as a lead who plans, with a builder and a reviewer.
        const full = /"full": "a lead who plans/.test(turn.text);
        turn.emit({
          type: "text",
          messageId: "d",
          text: JSON.stringify({ team: { value: full ? "full" : "none", confidence: 0.9 } }),
        });
        return "end_turn";
      };
    };
    const res = await h.cmd("tasks.create", {
      text: "rebuild the api's auth, billing and admin",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.team).toEqual(["acme-lead", "acme-builder", "acme-reviewer"]);
    const line = (await systemTexts(res.body.id)).find((t) =>
      t.startsWith("The stand-in agent picked the team"),
    );
    expect(line).toBeDefined();
    const recent = (await h.cmd("decisions.recent", {})).body as {
      use: string;
      task?: string;
      provider: string;
    }[];
    expect(recent[0]).toMatchObject({ use: "routing", task: res.body.id, provider: "acp" });
  });

  it("falls back to one agent when the provider is not sure, and uses the org's team without asking", async () => {
    const { h } = await teamWorld({});
    const first = await h.cmd("tasks.create", {
      text: "fix the api readme",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    expect(first.body.team).toEqual(["acme-lead"]);
    expect((await systemTexts(first.body.id)).some((t) => t.includes("Picked by the rules"))).toBe(true);

    expect((await h.cmd("orgs.update", { id: "acme", team: ["acme-builder", "acme-reviewer"] })).status).toBe(
      200,
    );
    const second = await h.cmd("tasks.create", {
      text: "fix the api readme again",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    expect(second.body.team).toEqual(["acme-builder", "acme-reviewer"]);
  });
});

async function must(h: World["h"], name: string, body: unknown): Promise<void> {
  const res = await h.cmd(name, body);
  if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
}

describe("mentions that ask for nothing", () => {
  /** A lead and a builder, with the stand-in agent answering each mention by `answer`. */
  async function mentionWorld(
    lead: Turns,
    answer: (message: string) => { value: boolean; confidence: number },
  ) {
    const world = await teamWorld({ "acme-lead": lead }, { reviewer: false });
    const { h } = world;
    expect(
      (await h.cmd("decisions.set", { order: ["acp", "rules"], acp_agent: "acme-builder" })).status,
    ).toBe(200);
    const asked: string[] = [];
    const team = h.runtime.onSession;
    h.runtime.onSession = (session, start) => {
      team?.(session, start);
      if (!start.scratch) return;
      session.script = async (turn) => {
        const message = /message: (.*)/.exec(turn.text)?.[1] ?? "";
        asked.push(message);
        turn.emit({ type: "text", messageId: "d", text: JSON.stringify({ acts_1: answer(message) }) });
        return "end_turn";
      };
    };
    expect(
      (
        await h.cmd("tasks.create", {
          text: "tidy the api readme",
          repos: [{ project: "acme-api" }],
          team: ["acme-lead", "acme-builder"],
          start: true,
        })
      ).status,
    ).toBe(200);
    return { ...world, asked };
  }

  it("a status line wakes nobody, without asking the provider", async () => {
    const { h, prompts, asked } = await mentionWorld(
      [
        say("Reading the readme first."),
        say("I'm still waiting. @acme-builder's check is running and it reports to @acme-lead."),
      ],
      () => ({ value: true, confidence: 0.95 }),
    );
    await until(async () => (await status("ACM-1")) === "review", "review after the first turn");
    await h.cmd("room.send", { task: "ACM-1", text: "@acme-lead go on" });
    await until(
      async () =>
        (await systemTexts("ACM-1")).includes(
          "@acme-lead only reported status to @acme-builder, so nobody was woken.",
        ),
      "the quiet line",
    );
    await until(async () => (await status("ACM-1")) === "review", "review");
    expect(await handoffs("ACM-1")).toEqual([]);
    expect(prompts["acme-builder"]).toBeUndefined();
    expect(asked).toEqual([]);
    expect(await systemTexts("ACM-1")).toContain(
      "@acme-lead only reported status to @acme-builder, so nobody was woken.",
    );
  });

  it("a sure no keeps an addressed agent asleep and tells the writer with its next prompt, a plain ask wakes it without the provider, and an unsure answer wakes it as before", async () => {
    const { h, prompts, full, asked } = await mentionWorld(
      [
        // The first turn counts as a change: the worktree had no fingerprint before it.
        say("Reading the readme first."),
        say("@acme-builder thanks, that is all from me for now."),
        // The turn that reads majhi's note: once, so this "thanks" gets no second note.
        say("@acme-builder right, thanks."),
        say("@acme-builder please add a test for the readme links."),
        say("@acme-builder maybe glance at the readme."),
      ],
      (message) =>
        message.includes("thanks") ? { value: false, confidence: 0.95 } : { value: false, confidence: 0.6 },
    );
    await until(async () => (await status("ACM-1")) === "review", "review after the first turn");
    await h.cmd("room.send", { task: "ACM-1", text: "@acme-lead go on" });
    await until(() => (prompts["acme-lead"]?.length ?? 0) === 2, "the lead's second turn");
    await settled("ACM-1", ["acme-lead", "acme-builder"]);
    // The note starts no turn: the lead is idle and has not read it yet.
    expect(prompts["acme-lead"]).toHaveLength(2);
    expect(full["acme-lead"]?.[1]).not.toContain("was not woken");
    expect(asked).toHaveLength(1);

    await h.cmd("room.send", { task: "ACM-1", text: "@acme-lead anything else?" });
    await until(() => (prompts["acme-lead"]?.length ?? 0) === 3, "the lead's next turn");
    expect(full["acme-lead"]?.[2]).toContain(
      "@acme-builder was not woken: your message did not ask them for anything.",
    );
    await settled("ACM-1", ["acme-lead", "acme-builder"]);
    expect(asked).toHaveLength(2);
    expect(prompts["acme-builder"]).toBeUndefined();
    expect(prompts["acme-lead"]).toHaveLength(3);
    expect(
      (await systemTexts("ACM-1")).filter(
        (t) =>
          t === "@acme-lead mentioned @acme-builder without asking for anything, so they were not woken.",
      ),
    ).toHaveLength(2);

    await h.cmd("room.send", { task: "ACM-1", text: "@acme-lead carry on" });
    await until(() => (prompts["acme-builder"]?.length ?? 0) === 1, "the builder woken by a request");
    await until(async () => (await status("ACM-1")) === "review", "review after the request");
    expect(asked).toHaveLength(2);
    // The second "thanks" got no note: that turn read one.
    expect(full["acme-lead"]?.[3]).not.toContain("was not woken");

    await h.cmd("room.send", { task: "ACM-1", text: "@acme-lead one more thing" });
    await until(() => (prompts["acme-builder"]?.length ?? 0) === 2, "the builder woken when unsure");
    expect(asked).toHaveLength(3);
    expect(await handoffs("ACM-1")).toEqual([
      "acme-lead>acme-builder (mention)",
      "acme-lead>acme-builder (mention)",
    ]);
    const recent = (await h.cmd("decisions.recent", {})).body as {
      use: string;
      outcome?: { text: string };
    }[];
    expect(recent.filter((d) => d.use === "routing")).toHaveLength(3);
  });

  it("a name in passing wakes nobody and asks no provider, even when the turn changed files", async () => {
    const { h, prompts, asked } = await mentionWorld(
      [
        // The first turn counts as a change.
        say("Done: tests pass. Results are posted for @acme-builder. Nothing else for me."),
        say("Reported to @acme-builder, I'm mentioning no one, so this wakes nobody."),
        say("proc-3 ended green, as @acme-builder said. No action needed."),
        say("Thanks @acme-builder."),
      ],
      () => ({ value: true, confidence: 0.95 }),
    );
    for (const turns of [1, 2, 3, 4]) {
      if (turns > 1) await h.cmd("room.send", { task: "ACM-1", text: "@acme-lead go on" });
      await until(() => (prompts["acme-lead"]?.length ?? 0) === turns, `lead turn ${turns}`);
      await settled("ACM-1", ["acme-lead", "acme-builder"]);
    }
    expect(prompts["acme-builder"]).toBeUndefined();
    expect(asked).toEqual([]);
    expect(await handoffs("ACM-1")).toEqual([]);
  });

  it("a line that starts with the name still wakes it, in a list, in bold or after a status sentence, without the provider", async () => {
    const { h, prompts, asked } = await mentionWorld(
      [
        say("Reading the readme first."),
        say("@acme-builder: please review the diff."),
        say("- **@acme-builder**: review the diff"),
        say("Tests pass.\n@acme-builder please merge"),
      ],
      () => ({ value: false, confidence: 0.95 }),
    );
    await until(async () => (await status("ACM-1")) === "review", "review after the first turn");
    for (const turns of [1, 2, 3]) {
      await h.cmd("room.send", { task: "ACM-1", text: "@acme-lead go on" });
      await until(() => (prompts["acme-builder"]?.length ?? 0) === turns, `builder woken ${turns}`);
      await settled("ACM-1", ["acme-lead", "acme-builder"]);
    }
    expect(asked).toEqual([]);
  });

  it("a name in passing does not add an agent outside the team, and an addressing one does", async () => {
    const { h, prompts, full } = await teamWorld(
      {
        "acme-lead": [
          say("Reading the readme first."),
          say("Done. Over to you then, @acme-reviewer please review it."),
          say("@acme-reviewer: please review the diff."),
        ],
      },
      {},
    );
    await h.cmd("tasks.create", {
      text: "tidy the api readme",
      repos: [{ project: "acme-api" }],
      team: ["acme-lead"],
      start: true,
    });
    await until(async () => (await status("ACM-1")) === "review", "review after the first turn");
    await h.cmd("room.send", { task: "ACM-1", text: "@acme-lead go on" });
    await until(() => (prompts["acme-lead"]?.length ?? 0) === 2, "the lead's second turn");
    await settled("ACM-1", ["acme-lead", "acme-reviewer"]);
    expect(((await h.cmd("tasks.get", { id: "ACM-1" })).body.team as string[]).sort()).toEqual(["acme-lead"]);
    expect(prompts["acme-reviewer"]).toBeUndefined();
    // The writer hears about it in the room, but no turn starts for it.
    expect(await systemTexts("ACM-1")).toContain(
      "@acme-lead named @acme-reviewer in passing, so it was not added to the team.",
    );
    expect(prompts["acme-lead"]).toHaveLength(2);

    await h.cmd("room.send", { task: "ACM-1", text: "@acme-lead go on" });
    await until(() => (prompts["acme-reviewer"]?.length ?? 0) === 1, "the reviewer woken");
    // Its next prompt carries the note, with how to add the agent.
    expect(full["acme-lead"]?.[2]).toContain("@acme-reviewer was not added to the team");
    expect(full["acme-lead"]?.[2]).toContain('start a line with "@acme-reviewer: please ..."');
    expect(((await h.cmd("tasks.get", { id: "ACM-1" })).body.team as string[]).sort()).toEqual([
      "acme-lead",
      "acme-reviewer",
    ]);
    expect(await systemTexts("ACM-1")).toContain("@acme-lead added @acme-reviewer (Reviewer) to the team.");
  });

  it("a handoff that asks in so many words wakes the teammate without the provider", async () => {
    const { h, prompts, asked } = await mentionWorld(
      [
        say("Reading the readme first."),
        say(
          "Plan v3 is recorded. The server part starts now.\n\n@acme-builder: please build the server side of the export in this worktree, on branch task/acm-1-export.",
        ),
      ],
      () => ({ value: false, confidence: 0.95 }),
    );
    await until(async () => (await status("ACM-1")) === "review", "review after the first turn");
    await h.cmd("room.send", { task: "ACM-1", text: "@acme-lead go on" });
    await until(() => (prompts["acme-builder"]?.length ?? 0) === 1, "the builder woken by the handoff");
    expect(asked).toEqual([]);
    expect(await handoffs("ACM-1")).toEqual(["acme-lead>acme-builder (mention)"]);
  });
});
