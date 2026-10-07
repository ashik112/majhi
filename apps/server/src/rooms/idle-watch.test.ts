import { basename } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FakeSession, StopReason, Turn } from "../testing/fakeSession.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { childMoves, stalled } from "./idle-watch.ts";

/**
 * A running task never goes silent: when a turn ends and nobody works, nothing waits for the owner
 * and no background process is waited on, the lead is woken once, or the owner when the lead ended.
 * The rooms here are parents with a subtask that does not start by itself, so ACM-1 stays running
 * when its agents are idle, as PRV-style parents do.
 */

let w: World;
/** Lets held turns end, so cleanup does not wait for them. */
let releaseAll: () => void = () => undefined;
afterEach(async () => {
  releaseAll();
  releaseAll = () => undefined;
  await w?.cleanup();
});

type Step = string | { text: string; stop: StopReason };
type Turns = ((turn: Turn) => Promise<Step>)[];
const say = (text: string) => async () => text;
/** The model's safeguards stop the turn, as Claude Code reports a flagged message. */
const refuse =
  (text = "") =>
  async (): Promise<Step> => ({ text, stop: "refusal" });
const QUIET_MS = 20;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (await check()) return;
    await pause(5);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Two models on offer, for agents that can fall back after a refusal. */
const TWO_MODELS = [
  { id: "opus", name: "Opus" },
  { id: "sonnet", name: "Sonnet" },
];

/**
 * Acme with a lead on Codex, the builder on Claude and a reviewer on a second Claude account.
 * `opus`: these agents' sessions offer Opus and Sonnet and run on Opus; the others offer no choice.
 * `alone`: the task has the lead only and no subtask, so it would go to review when it is idle.
 */
async function parentWorld(scripts: Record<string, Turns>, opts: { opus?: string[]; alone?: boolean } = {}) {
  w = await taskWorld({ idleWatchMs: QUIET_MS });
  const { h } = w;
  const must = async (name: string, body: unknown) => {
    const res = await h.cmd(name, body);
    if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
    return res;
  };
  await must("accounts.create", { id: "codex-acme", tool: "codex", org: "acme", auth: "login" });
  await must("agents.create", {
    id: "acme-lead",
    frontmatter: { scope: "acme", role: "Lead", account: "codex-acme", perms: ["edit", "shell"] },
    instructions: "Plan and delegate.\n",
  });
  await must("accounts.create", { id: "claude-acme-2", tool: "claude", org: "acme", auth: "login" });
  await must("agents.create", {
    id: "acme-reviewer",
    frontmatter: { scope: "acme", role: "Reviewer", account: "claude-acme-2", perms: ["shell"] },
    instructions: "Review carefully.\n",
  });
  const agentOf: Record<string, string> = {
    "claude-acme": "acme-builder",
    "codex-acme": "acme-lead",
    "claude-acme-2": "acme-reviewer",
  };
  const prompts: Record<string, string[]> = {};
  const sessions: Record<string, FakeSession> = {};
  h.runtime.onSession = (session, start) => {
    if (start.scratch) return;
    const agent = agentOf[basename(start.account.home)] ?? "unknown";
    sessions[agent] = session;
    if (opts.opus?.includes(agent)) {
      session.models = { models: TWO_MODELS, efforts: [], defaultModel: "opus" };
      // Like a real session: the model it runs is the one last set.
      session.setOption = async (category, value) => {
        session.options.push([category, value]);
        if (category === "model") session.models = { ...session.models, defaultModel: value };
      };
    }
    session.script = async (turn) => {
      const list = prompts[agent] ?? [];
      prompts[agent] = list;
      list.push(turn.text);
      const step = scripts[agent]?.[list.length - 1];
      const out = step === undefined ? "ok" : await step(turn);
      const { text, stop } = typeof out === "string" ? { text: out, stop: "end_turn" as const } : out;
      if (text !== "") turn.emit({ type: "text", messageId: `m${list.length}`, text });
      return stop;
    };
  };
  await must("tasks.create", {
    text: "export orders from api",
    repos: [{ project: "acme-api" }],
    team: opts.alone === true ? ["acme-lead"] : ["acme-lead", "acme-builder", "acme-reviewer"],
    start: false,
  });
  // A subtask nobody started: it does not move by itself, so ACM-1 stays running.
  if (opts.alone !== true) {
    await must("tasks.split", {
      task: "ACM-1",
      children: [{ text: "add docs/export.md to api", repos: [{ project: "acme-api" }] }],
      start: false,
    });
  }
  await must("tasks.start", { id: "ACM-1" });
  return { h, prompts, sessions };
}

const task = async () =>
  (await w.h.cmd("tasks.get", { id: "ACM-1" })).body as { status: string; pausedReason?: string };

/** Lets every turn end and the watch look at the room a few times over. */
async function settle(): Promise<void> {
  await w.h.majhi.services.runs.idle();
  await pause(QUIET_MS * 10);
  await w.h.majhi.services.runs.idle();
}

describe("a turn the model's safeguards stopped", () => {
  it("pauses the task for the owner when the lead refuses with no other model, and never sends it to review", async () => {
    const { prompts } = await parentWorld({ "acme-lead": [refuse("Planning the export.")] }, { alone: true });
    await until(async () => (await task()).status !== "running", "the task to stop running");
    await settle();

    expect(prompts["acme-lead"]).toHaveLength(1);
    expect(await task()).toMatchObject({ status: "paused", pausedReason: "blocked" });
  });

  it("never loops: a lead that always refuses switches once, then the owner is asked", async () => {
    const always = [refuse(), refuse(), refuse(), refuse(), refuse()];
    const { prompts, sessions } = await parentWorld(
      { "acme-lead": always, "acme-builder": always },
      { opus: ["acme-lead", "acme-builder"] },
    );
    await until(async () => (await task()).status === "paused", "the owner asked");
    await settle();
    await pause(QUIET_MS * 10);

    expect(prompts["acme-lead"]).toHaveLength(2);
    expect(prompts["acme-builder"]).toBeUndefined();
    expect(sessions["acme-lead"]?.options).toEqual([["model", "sonnet"]]);
    expect(await task()).toMatchObject({ status: "paused", pausedReason: "blocked" });
  });
});

describe("the idle rule", () => {
  const quiet = {
    status: "running" as const,
    working: 0,
    ownerCard: false,
    process: false,
    childMoves: false,
  };

  it("is stalled only when a running task has nothing left that moves", () => {
    expect(stalled(quiet)).toBe(true);
    expect(stalled({ ...quiet, status: "review" })).toBe(false);
    expect(stalled({ ...quiet, working: 1 })).toBe(false);
    expect(stalled({ ...quiet, ownerCard: true })).toBe(false);
    expect(stalled({ ...quiet, process: true })).toBe(false);
    expect(stalled({ ...quiet, childMoves: true })).toBe(false);
  });

  it("counts a subtask as moving unless it never starts by itself or waits for its own ancestor", () => {
    const child = { startWhenReady: false, waitsOnAncestor: false };
    expect(childMoves({ ...child, status: "running" })).toBe(true);
    expect(childMoves({ ...child, status: "review" })).toBe(true);
    expect(childMoves({ ...child, status: "paused" })).toBe(true);
    expect(childMoves({ ...child, status: "done" })).toBe(false);
    expect(childMoves({ ...child, status: "inbox" })).toBe(false);
    expect(childMoves({ ...child, status: "ready", startWhenReady: true })).toBe(true);
    expect(childMoves({ status: "ready", startWhenReady: true, waitsOnAncestor: true })).toBe(false);
  });
});

/** What Claude Code does with an OAuth session it cannot refresh: says so, then the prompt fails on ACP's auth error. */
const signedOut = async (turn: Turn): Promise<Step> => {
  turn.emit({
    type: "text",
    messageId: "auth",
    text: "Failed to authenticate: OAuth session expired and could not be refreshed",
  });
  throw Object.assign(new Error("Authentication required"), { code: -32000 });
};
const statusOf = async (id: string) =>
  ((await w.h.cmd("accounts.list")).body as { id: string; status: string }[]).find((a) => a.id === id)
    ?.status;

describe("a turn that failed on its account's sign-in", () => {
  it("marks the account, hands the step back to the lead, and refuses to hand it to that agent again", async () => {
    const { prompts } = await parentWorld({
      "acme-lead": [
        say("@acme-builder please build the export."),
        say("@acme-builder please try the export again."),
        say("@acme-reviewer please build the export instead."),
        say("Done for now."),
      ],
      "acme-builder": [signedOut],
      "acme-reviewer": [say("Built it.")],
    });
    await until(() => (prompts["acme-reviewer"]?.length ?? 0) === 1, "the reviewer taking the step");
    await settle();

    expect(await statusOf("claude-acme")).toBe("needs-login");
    // The second handoff to the builder is refused: it never gets another prompt.
    expect(prompts["acme-builder"]).toHaveLength(1);
  });

  it("refuses the mention tool for an agent whose account needs a sign-in", async () => {
    const { prompts } = await parentWorld({ "acme-lead": [say("Planning.")] });
    await until(() => (prompts["acme-lead"]?.length ?? 0) === 1, "the lead's turn");
    await w.h.majhi.services.accounts.markSignedOut("claude-acme", "Failed to authenticate");
    await expect(
      w.h.majhi.services.coordinator.mention(
        { task: "ACM-1", agent: "acme-lead" },
        "acme-builder",
        "build it",
      ),
    ).rejects.toThrow();
  });
});
