import { basename } from "node:path";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { FakeSession, StopReason, Turn } from "../testing/fakeSession.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { childMoves, lastLine, stalled } from "./idle-watch.ts";

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

async function items(): Promise<RoomItem[]> {
  w.h.majhi.services.room.flush("ACM-1");
  const page = await w.h.cmd("room.items", { task: "ACM-1", limit: 500 });
  return [...(page.body.items as RoomItem[])].sort((a, b) => a.seq - b.seq);
}
const systemTexts = async () => (await items()).flatMap((i) => (i.type === "system" ? [i.text] : []));
const task = async () =>
  (await w.h.cmd("tasks.get", { id: "ACM-1" })).body as { status: string; pausedReason?: string };

/** Lets every turn end and the watch look at the room a few times over. */
async function settle(): Promise<void> {
  await w.h.majhi.services.runs.idle();
  await pause(QUIET_MS * 10);
  await w.h.majhi.services.runs.idle();
}

describe("a running task never goes silent", () => {
  it("wakes the lead once when a builder ends without a mention, and again after the next quiet turn", async () => {
    const { prompts } = await parentWorld({
      "acme-lead": [
        say("@acme-builder please build the web part."),
        say("@acme-builder please build the server part too."),
        say("Both parts are built."),
      ],
      "acme-builder": [
        say("The web part is done.\nThe server builder can take the worktree now."),
        say("Server part done."),
      ],
    });
    await until(async () => (await task()).status === "paused", "the owner asked");
    await settle();

    expect(prompts["acme-builder"]).toHaveLength(2);
    expect(prompts["acme-lead"]).toHaveLength(3);
    expect(prompts["acme-lead"]?.[1]).toContain(
      '@acme-builder finished its turn and nobody is working on ACM-1 now. Its last line: "The server builder can take the worktree now."',
    );
    expect(prompts["acme-lead"]?.[2]).toContain('Its last line: "Server part done."');
    const said = await systemTexts();
    expect(
      said.filter((t) => t === "Nobody was working on ACM-1 after @acme-builder finished. Woke @acme-lead."),
    ).toHaveLength(2);
    // The lead ended last with nothing pending: the owner is asked, the lead is not woken by itself.
    expect(said).toContain(
      'Nobody is working on ACM-1 and nothing is pending. @acme-lead\'s last message: "Both parts are built."',
    );
    expect(await task()).toMatchObject({ status: "paused", pausedReason: "blocked" });
  });

  it("wakes the agent a builder mentions, not the lead", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    releaseAll = release;
    const { prompts } = await parentWorld({
      "acme-lead": [say("@acme-builder please build the web part.")],
      "acme-builder": [say("Built. @acme-reviewer please review the diff.")],
      "acme-reviewer": [
        async () => {
          await gate;
          return "Reviewed.";
        },
      ],
    });
    await until(() => (prompts["acme-reviewer"]?.length ?? 0) === 1, "the reviewer woken");
    await pause(QUIET_MS * 10);
    expect(prompts["acme-lead"]).toHaveLength(1);
    expect((await systemTexts()).some((t) => t.startsWith("Nobody"))).toBe(false);
    expect((await task()).status).toBe("running");
  });

  it("asks the owner when the lead ends with nothing pending, without waking the lead", async () => {
    const { prompts } = await parentWorld({ "acme-lead": [say("Plan recorded.\nNothing to hand on yet.")] });
    await until(async () => (await task()).status === "paused", "the owner asked");
    await settle();
    expect(prompts["acme-lead"]).toHaveLength(1);
    expect(prompts["acme-builder"]).toBeUndefined();
    expect(await systemTexts()).toContain(
      'Nobody is working on ACM-1 and nothing is pending. @acme-lead\'s last message: "Nothing to hand on yet."',
    );
    expect(await task()).toMatchObject({ status: "paused", pausedReason: "blocked" });
    const card = (await items()).find((i) => i.type === "paused");
    expect(card).toMatchObject({ reason: "blocked", state: "pending" });
  });

  it("does nothing while a question to the owner is pending", async () => {
    const { prompts } = await parentWorld({
      "acme-lead": [say("Should the export write CSV or JSON?")],
    });
    await until(async () => (await items()).some((i) => i.type === "owner-question"), "the question card");
    await settle();
    expect(prompts["acme-lead"]).toHaveLength(1);
    expect((await systemTexts()).some((t) => t.startsWith("Nobody"))).toBe(false);
    expect((await task()).status).toBe("running");
  });

  it("does nothing while an agent waits on a background process", async () => {
    const { prompts } = await parentWorld({
      "acme-lead": [
        async () => {
          await w.h.majhi.services.processes.start({
            task: "ACM-1",
            agent: "acme-lead",
            command: "sleep 30",
            wait: true,
          });
          return "Started the export check. I'll wait for it.";
        },
      ],
    });
    await until(() => (prompts["acme-lead"]?.length ?? 0) === 1, "the lead's turn");
    await settle();
    expect(prompts["acme-lead"]).toHaveLength(1);
    expect((await systemTexts()).some((t) => t.startsWith("Nobody"))).toBe(false);
    expect((await task()).status).toBe("running");
    await w.h.majhi.services.processes.stopTask("ACM-1");
  });
});

describe("a turn the model's safeguards stopped", () => {
  const overrides = async () =>
    ((await w.h.cmd("tasks.get", { id: "ACM-1" })).body as { overrides: Record<string, { model?: string }> })
      .overrides;

  it("moves a builder to the next model once and continues there", async () => {
    const { prompts, sessions } = await parentWorld(
      {
        "acme-lead": [say("@acme-builder please build the web part."), say("Both parts are built.")],
        "acme-builder": [refuse("Starting on the web part."), say("The web part is done.")],
      },
      { opus: ["acme-builder"] },
    );
    await until(async () => (await task()).status === "paused", "the owner asked");
    await settle();

    expect(prompts["acme-builder"]).toHaveLength(2);
    expect(prompts["acme-builder"]?.[1]).toContain("Continue from where you stopped.");
    expect(sessions["acme-builder"]?.options).toEqual([["model", "sonnet"]]);
    expect((await overrides())["acme-builder"]?.model).toBe("sonnet");
    const said = await systemTexts();
    expect(said).toContain(
      "@acme-builder was blocked by Opus's safeguards. Continuing on Sonnet for this task.",
    );
    // The builder then ended its turn itself: the lead hears it finished, not that it was blocked.
    expect(prompts["acme-lead"]).toHaveLength(2);
    expect(prompts["acme-lead"]?.[1]).toContain(
      '@acme-builder finished its turn and nobody is working on ACM-1 now. Its last line: "The web part is done."',
    );
    expect(said.some((t) => t.includes("goes back to the team"))).toBe(false);
  });

  it("wakes the lead once with the safeguards note when the next model refuses too", async () => {
    const { prompts, sessions } = await parentWorld(
      {
        "acme-lead": [say("@acme-builder please build the web part."), say("I will ask the owner.")],
        "acme-builder": [refuse("Starting on the web part."), refuse("Still blocked."), refuse(), refuse()],
      },
      { opus: ["acme-builder"] },
    );
    await until(async () => (await task()).status === "paused", "the owner asked");
    await settle();

    // One switch, then the step goes back to the lead: no third try, no second switch.
    expect(prompts["acme-builder"]).toHaveLength(2);
    expect(sessions["acme-builder"]?.options).toEqual([["model", "sonnet"]]);
    expect(prompts["acme-lead"]).toHaveLength(2);
    const note = prompts["acme-lead"]?.[1] ?? "";
    expect(note).toContain(
      '@acme-builder was blocked by its model\'s safeguards and stopped. Nobody is working on ACM-1 now. Its last line: "Still blocked."',
    );
    expect(note).toContain("Give its step to another teammate");
    expect(note).toContain("or rephrase the step and hand it back to it");
    const said = await systemTexts();
    expect(said).toContain(
      "@acme-builder was blocked by Sonnet's safeguards after the switch too. Its step goes back to the team.",
    );
    expect(
      said.filter(
        (t) =>
          t ===
          "Nobody was working on ACM-1 after @acme-builder was blocked by its model's safeguards. Woke @acme-lead.",
      ),
    ).toHaveLength(1);
    expect(await task()).toMatchObject({ status: "paused", pausedReason: "blocked" });
  });

  it("pauses the task for the owner when the lead refuses with no other model, and never sends it to review", async () => {
    const { prompts } = await parentWorld({ "acme-lead": [refuse("Planning the export.")] }, { alone: true });
    await until(async () => (await task()).status !== "running", "the task to stop running");
    await settle();

    expect(prompts["acme-lead"]).toHaveLength(1);
    const said = await systemTexts();
    expect(said).toContain(
      "@acme-lead was blocked by fake-model's safeguards and has no other model to try. Its step goes back to the team.",
    );
    expect(said).toContain(
      "@acme-lead was blocked by its model's safeguards and nobody is working on ACM-1. Rephrase the step, change its model, or give the step to another agent.",
    );
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
    const said = await systemTexts();
    expect(said.filter((t) => t.includes("Continuing on"))).toHaveLength(1);
    expect(await task()).toMatchObject({ status: "paused", pausedReason: "blocked" });
  });

  it("wakes nobody when the owner stops a turn with Esc", async () => {
    const { h, prompts } = await parentWorld({
      "acme-lead": [say("@acme-builder please build the web part.")],
      "acme-builder": [
        async (turn) => {
          await turn.untilCancelled();
          return "Stopped.";
        },
      ],
    });
    await until(() => (prompts["acme-builder"]?.length ?? 0) === 1, "the builder's turn");
    await h.cmd("room.cancel", { task: "ACM-1", agent: "acme-builder" });
    await settle();

    expect(prompts["acme-lead"]).toHaveLength(1);
    expect(prompts["acme-builder"]).toHaveLength(1);
    const said = await systemTexts();
    expect(said.some((t) => t.startsWith("Nobody") || t.includes("safeguards"))).toBe(false);
    expect((await task()).status).toBe("running");
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

  it("quotes the last non-empty line, trimmed", () => {
    expect(lastLine("Done.\n\n  The server builder can take the worktree now.  \n")).toBe(
      "The server builder can take the worktree now.",
    );
    expect(lastLine("x".repeat(300))).toHaveLength(200);
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
const fails = (message: string) => async (): Promise<Step> => {
  throw new Error(message);
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
    const said = await systemTexts();
    expect(said).toContain(
      "@acme-builder cannot run: its account claude-acme needs a new sign-in. Its step goes back to @acme-lead.",
    );
    expect(said).toContain(
      "@acme-builder could not run (its account claude-acme needs a new sign-in). Woke @acme-lead to give its step to a teammate.",
    );
    expect(prompts["acme-lead"]?.[1]).toContain(
      "@acme-builder cannot run: its account claude-acme needs a new sign-in, so the step you gave it did not start.",
    );
    // The second handoff to the builder is refused: it never gets another prompt.
    expect(said).toContain(
      "@acme-builder cannot run: its account claude-acme needs a new sign-in. Give the step to another teammate.",
    );
    expect(prompts["acme-builder"]).toHaveLength(1);
    expect(prompts["acme-lead"]?.[2]).toContain("Give the step to another teammate.");
    // Nobody pretends that nothing is pending.
    expect(said.some((t) => t.includes("nothing is pending"))).toBe(false);
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
    ).rejects.toThrow(
      "@acme-builder cannot run: its account claude-acme needs a new sign-in. Give the step to another teammate.",
    );
  });

  it("pauses the task as signed-out when the lead cannot sign in, and goes on once it can", async () => {
    // The lead is alone on the team: a teammate with a working account would take a signed-out lead's place.
    const { prompts } = await parentWorld(
      { "acme-lead": [signedOut, say("Exporting orders.")] },
      { alone: true },
    );
    await until(async () => (await task()).status === "paused", "the pause");
    expect(await task()).toMatchObject({ status: "paused", pausedReason: "signed-out" });
    expect(await statusOf("codex-acme")).toBe("needs-login");
    const card = (await items()).find((i) => i.type === "paused");
    expect(card).toMatchObject({ reason: "signed-out", state: "pending" });

    // The owner signs in: the check passes, and the same prompt goes to the lead again.
    w.h.runtime.usage = {
      plan: "pro",
      window: { usedPct: 1 },
      weekly: { usedPct: 1 },
      models: [],
      estimated: false,
      updatedAt: "2026-10-03T00:00:00.000Z",
    };
    await w.h.majhi.services.resilience.checkSignIns();
    await until(() => (prompts["acme-lead"]?.length ?? 0) === 2, "the work going on");
    expect(prompts["acme-lead"]?.[1]).toBe(prompts["acme-lead"]?.[0]);
    expect(await statusOf("codex-acme")).not.toBe("needs-login");
  });
});

describe("the owner's line names the real cause", () => {
  it("says a teammate's turn failed instead of nothing is pending", async () => {
    const { prompts } = await parentWorld({
      "acme-lead": [say("@acme-builder please build the export."), say("Waiting on the build.")],
      "acme-builder": [fails("Internal error: the adapter crashed")],
    });
    await until(async () => (await task()).status === "paused", "the owner asked");
    await settle();
    expect(prompts["acme-lead"]?.[1]).toContain(
      '@acme-builder\'s turn failed with an error: "Internal error: the adapter crashed".',
    );
    const said = await systemTexts();
    expect(said).toContain("Nobody was working on ACM-1 after @acme-builder failed. Woke @acme-lead.");
    expect(said).toContain(
      'Nobody is working on ACM-1: @acme-builder\'s last turn failed with "Internal error: the adapter crashed", and @acme-lead handed its step to nobody else. Give the step to another agent, or sign the account in and resume.',
    );
    expect(said.some((t) => t.includes("nothing is pending"))).toBe(false);
  });
});
