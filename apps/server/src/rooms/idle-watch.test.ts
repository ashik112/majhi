import { basename } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FakeSession, StopReason, Turn } from "../testing/fakeSession.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { childMoves, stalled } from "./idle-watch.ts";

/**
 * A running task never goes silent: when a turn ends and nobody works, nothing waits for the owner
 * and no background process is waited on, a plan with a step left is put back to work, or the owner is asked.
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
/** The model's safeguards stop the turn, as Claude Code reports a flagged message. */
const refuse =
  (text = "") =>
  async (): Promise<Step> => ({ text, stop: "refusal" });
/** The watch's own timer never fires in these tests: `settle` runs its check, so no wall clock decides. */
const NEVER_MS = 3_600_000;

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
  w = await taskWorld({ idleWatchMs: NEVER_MS });
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
    await must("tasks.create", {
      text: "add docs/export.md to api",
      repos: [{ project: "acme-api" }],
      parent: "ACM-1",
      start: false,
    });
  }
  await must("tasks.start", { id: "ACM-1" });
  return { h, prompts, sessions };
}

const task = async () =>
  (await w.h.cmd("tasks.get", { id: "ACM-1" })).body as { status: string; pausedReason?: string };

/** Lets every turn end and the watch look at the room after each one, until no turn is left. */
async function settle(): Promise<void> {
  const { runs, idleWatch } = w.h.majhi.services;
  await runs.idle();
  // A refusal can chain (switch model, refuse again, ask the owner): a few looks cover the longest chain.
  for (let look = 0; look < 6; look++) {
    await idleWatch.check("ACM-1");
    await runs.idle();
  }
}

describe("a turn the model's safeguards stopped", () => {
  it("pauses the task for the owner when the lead refuses with no other model, and never sends it to review", async () => {
    const { prompts } = await parentWorld({ "acme-lead": [refuse("Planning the export.")] }, { alone: true });
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
    await settle();

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
