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
  h.runtime.onSession = (session, start) => {
    const agent = agentOf[basename(start.account.home)] ?? "unknown";
    session.script = async (turn) => {
      const list = prompts[agent] ?? [];
      prompts[agent] = list;
      list.push(turn.text);
      const step = scripts[agent]?.[list.length - 1];
      const text = step === undefined ? "ok" : await step(turn);
      turn.emit({ type: "text", messageId: `m${list.length}`, text });
      return "end_turn";
    };
  };
  return { h, prompts };
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

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
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
  it("pauses with reason owner after too many agent turns, and an owner message resets it", async () => {
    const ping = say("@acme-reviewer your turn.");
    const pong = say("@acme-builder your turn.");
    const { h } = await teamWorld(
      { "acme-builder": Array(10).fill(ping), "acme-reviewer": Array(10).fill(pong) },
      { lead: false },
    );
    expect((await h.cmd("settings.set", { rooms: { max_agent_turns: 3 } })).status).toBe(200);
    await h.cmd("tasks.create", {
      text: "add a health endpoint to api",
      team: ["acme-builder", "acme-reviewer"],
      start: true,
    });
    await until(async () => (await status("ACM-1")) === "paused", "paused");
    await h.majhi.services.runs.idle("ACM-1");
    const task = (await h.cmd("tasks.get", { id: "ACM-1" })).body;
    expect(task.pausedReason).toBe("owner");
    expect(await handoffs("ACM-1")).toHaveLength(3);
    expect((await systemTexts("ACM-1")).some((t) => t.startsWith("3 agent turns without you."))).toBe(true);

    const sent = await h.cmd("room.send", { task: "ACM-1", text: "carry on" });
    expect(sent.status).toBe(200);
    expect(sent.body.item.to).toBe("acme-builder");
    expect(h.majhi.services.store.tasks.roomState("ACM-1").agentTurns).toBe(0);
  });
});

describe("owner messages", () => {
  it("go to the lead without a mention, to every mentioned agent, and add a mentioned agent to the team", async () => {
    const { h, prompts } = await teamWorld({});
    await h.cmd("tasks.create", { text: "add a health endpoint to api", team: ["acme-lead"], start: true });
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
    await h.cmd("tasks.create", { text: "add a health endpoint to api", start: false });
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
    await h.cmd("tasks.create", { text: "add a health endpoint to api", team: ["acme-lead"], start: false });
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
        const options = [...turn.text.matchAll(/"(a lead who plans[^"]*)"/g)].map((m) => m[1]);
        turn.emit({
          type: "text",
          messageId: "d",
          text: JSON.stringify({ team: { value: options[0], confidence: 0.9 } }),
        });
        return "end_turn";
      };
    };
    const res = await h.cmd("tasks.create", {
      text: "rebuild the api's auth, billing and admin",
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
    const first = await h.cmd("tasks.create", { text: "fix the api readme", start: false });
    expect(first.body.team).toEqual(["acme-lead"]);
    expect((await systemTexts(first.body.id)).some((t) => t.includes("Picked by the rules"))).toBe(true);

    expect((await h.cmd("orgs.update", { id: "acme", team: ["acme-builder", "acme-reviewer"] })).status).toBe(
      200,
    );
    const second = await h.cmd("tasks.create", { text: "fix the api readme again", start: false });
    expect(second.body.team).toEqual(["acme-builder", "acme-reviewer"]);
  });
});

async function must(h: World["h"], name: string, body: unknown): Promise<void> {
  const res = await h.cmd(name, body);
  if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
}
