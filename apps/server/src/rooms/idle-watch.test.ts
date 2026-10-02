import { basename } from "node:path";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { Turn } from "../testing/fakeSession.ts";
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

type Turns = ((turn: Turn) => Promise<string>)[];
const say = (text: string) => async () => text;
const QUIET_MS = 20;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (await check()) return;
    await pause(5);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Acme with a lead on Codex, the builder on Claude and a reviewer on a second Claude account. */
async function parentWorld(scripts: Record<string, Turns>) {
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
  h.runtime.onSession = (session, start) => {
    if (start.scratch) return;
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
  await must("tasks.create", {
    text: "export orders from api",
    repos: [{ project: "acme-api" }],
    team: ["acme-lead", "acme-builder", "acme-reviewer"],
    start: false,
  });
  // A subtask nobody started: it does not move by itself, so ACM-1 stays running.
  await must("tasks.split", {
    task: "ACM-1",
    children: [{ text: "add docs/export.md to api", repos: [{ project: "acme-api" }] }],
    start: false,
  });
  await must("tasks.start", { id: "ACM-1" });
  return { h, prompts };
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
