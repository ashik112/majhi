import { basename } from "node:path";
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
  h.runtime.onSession = (session, start) => {
    // A decision stand-in's session is not the agent's turn.
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
  return { h, prompts };
}

async function must(h: World["h"], name: string, body: unknown): Promise<void> {
  const res = await h.cmd(name, body);
  if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
}

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
  });
});
