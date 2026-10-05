import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { Turn } from "../testing/fakeSession.ts";
import { taskWorld, type World } from "../testing/world.ts";

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

const status = async (task: string) => (await w.h.cmd("tasks.get", { id: task })).body.status as string;

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

async function must(h: World["h"], name: string, body: unknown): Promise<void> {
  const res = await h.cmd(name, body);
  if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
}

describe("work the lead has not reviewed", () => {
  it("wakes the lead once instead of going to review, then the task goes to review", async () => {
    const worktree = () => join(w.taskDir("ACM-1"), "acme-api");
    const { h, prompts, full } = await teamWorld(
      {
        "acme-lead": [say("@acme-builder: please build the health endpoint."), say("Looked at it. Done.")],
        "acme-builder": [
          async () => {
            await writeFile(join(worktree(), "health.ts"), "export const health = () => 'ok';\n");
            return "Built the health endpoint.";
          },
        ],
      },
      { reviewer: false },
    );
    await h.cmd("tasks.create", {
      text: "add a health endpoint to api",
      repos: [{ project: "acme-api" }],
      team: ["acme-lead", "acme-builder"],
      start: true,
    });
    await until(() => (prompts["acme-lead"]?.length ?? 0) === 2, "the lead woken to review");
    await until(async () => (await status("ACM-1")) === "review", "review after the lead's turn");
    expect(full["acme-lead"]?.[1]).toContain("A teammate changed the worktrees since your last turn");
    expect(await systemTexts("ACM-1")).toContain(
      "Nobody is working on ACM-1, but a teammate changed the worktrees and nobody has reviewed it. Woke @acme-lead to review that work before the task goes to review.",
    );
    expect(await handoffs("ACM-1")).toEqual(["acme-lead>acme-builder (mention)"]);
    expect(prompts["acme-lead"]).toHaveLength(2);
  });
});

describe("owner messages", () => {
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
