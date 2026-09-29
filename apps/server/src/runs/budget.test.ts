import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startSession } from "@majhi/acp";
import { type FakeAgentOptions, fakeAdapter } from "@majhi/acp/testing";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

/**
 * The context budget (SPEC 5.13) end to end: the real ACP engine against the fake adapter,
 * which reports rising usage and answers `/compact` and the handoff request.
 */

let w: World;
afterEach(() => w?.cleanup());

async function world(options: FakeAgentOptions = {}): Promise<World> {
  w = await taskWorld();
  w.h.env.runtime.adapters = { claude: fakeAdapter("claude", { signedIn: true, ...options }) };
  w.h.runtime.startSession = (start) => {
    w.h.runtime.starts.push(start);
    return startSession(start);
  };
  return w;
}

/** The prompts a session of the fake received, as it stored them in the task folder. */
async function received(sessionId: string | undefined, task = "ACM-1"): Promise<string[]> {
  const file = join(w.taskDir(task), ".fake-sessions", `${sessionId}.json`);
  const stored = JSON.parse(await readFile(file, "utf8")) as { messages: { role: string; text: string }[] };
  return stored.messages.filter((m) => m.role === "user").map((m) => m.text);
}

const runs = () => w.h.majhi.services.runs;
const live = (agent = "acme-builder", task = "ACM-1") => w.h.majhi.services.room.getLive(task, agent);

async function items(task = "ACM-1"): Promise<RoomItem[]> {
  const page = await w.h.cmd("room.items", { task, limit: 500 });
  return [...(page.body.items as RoomItem[])].sort((a, b) => (a.at < b.at ? -1 : 1));
}
const contexts = async (task = "ACM-1") =>
  (await items(task)).filter((i): i is Extract<RoomItem, { type: "context" }> => i.type === "context");
const systems = async () => (await items()).flatMap((i) => (i.type === "system" ? [i.text] : []));

async function start(text = "fix api"): Promise<void> {
  const res = await w.h.cmd("tasks.create", { text, start: true });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await runs().idle();
}

async function send(text: string, task = "ACM-1"): Promise<void> {
  const res = await w.h.cmd("room.send", { task, text });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await runs().idle();
}

describe("compaction with the fake adapter", () => {
  it("compacts natively when the agent passes 80%, and says so in the room", async () => {
    await world({ risingUsage: 170_000 });
    await start();
    const [event] = await contexts();
    expect(event).toMatchObject({ agent: "acme-builder", method: "native", before: 170_000, after: 17_000 });
    expect(event?.note).toBeUndefined();
    expect(live()?.usage).toEqual({ used: 17_000, size: 200_000 });
    // The same session goes on: no new process, nothing re-read.
    await send("echo: still here");
    expect(w.h.majhi.services.store.runs.forTask("ACM-1")).toHaveLength(1);
  });

  it("hands off to a fresh session with the agent's note when /compact does not help", async () => {
    await world({ risingUsage: 170_000, compactNoop: true });
    await start();
    const [event] = await contexts();
    expect(event).toMatchObject({ method: "handoff", before: 170_000, note: ".handoffs/acme-builder-1.md" });
    const note = await readFile(join(w.taskDir("ACM-1"), ".handoffs", "acme-builder-1.md"), "utf8");
    expect(note).toContain("## Next step\n\nRun the tests.");
    // The note request and /compact are majhi's own talk: nothing of it shows as agent text.
    const said = (await items()).flatMap((i) => (i.type === "agent" ? [i.text] : []));
    expect(said.join("\n")).not.toContain("Compacted the conversation");
    expect(said.join("\n")).not.toContain("## Original task");
    expect(live()?.usage).toBeUndefined();

    await send("echo: next please");
    const rows = w.h.majhi.services.store.runs.forTask("ACM-1");
    // Its own turn filled the fresh session again, so it handed off too; the full one was never loaded.
    expect(rows.map((r) => r.stopReason)).toEqual(["handoff", "handoff"]);
    // The fresh session did not load the full one.
    expect(rows[1]?.sessionId).not.toBe(rows[0]?.sessionId);
    const [first] = await received(rows[1]?.sessionId);
    expect(first).toMatch(/^majhi replaced your previous session/);
    expect(first).toContain("Run the tests.");
    expect(first?.endsWith("# The owner's message\n\necho: next please")).toBe(true);
  });

  it("recovers from max_tokens with a note majhi builds, and pauses after two compactions in one turn", async () => {
    await world();
    await start();
    await send("stop:max_tokens");
    const events = await contexts();
    expect(events.map((e) => e.method)).toEqual(["recovery", "recovery"]);
    const note = await readFile(join(w.taskDir("ACM-1"), ".handoffs", "acme-builder-1.md"), "utf8");
    expect(note).toContain("Written by majhi from saved state (the session hit its limit)");
    expect(note).toContain("Owner: stop:max_tokens");
    const text = await systems();
    expect(
      text.some((t) => t.includes("still over its context budget after 2 compactions in one turn")),
    ).toBe(true);
    expect(live()?.status).toBe("paused");
    const got = (await w.h.cmd("tasks.get", { id: "ACM-1" })).body;
    expect(got).toMatchObject({
      status: "paused",
      pausedReason: "error",
    });
  });

  it("rotates after max_turns", async () => {
    await world();
    expect((await w.h.cmd("settings.set", { context: { max_turns: 2 } })).status).toBe(200);
    await start();
    expect(await contexts()).toEqual([]);
    await send("echo: two");
    const [event] = await contexts();
    expect(event).toMatchObject({ method: "rotation", note: ".handoffs/acme-builder-1.md" });
    expect(live()?.turns).toBe(0);
  });

  it("starts a fresh session on request", async () => {
    await world();
    await start();
    const res = await w.h.cmd("room.fresh", { task: "ACM-1" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.item).toMatchObject({
      type: "context",
      method: "fresh",
      note: ".handoffs/acme-builder-1.md",
    });
    await send("echo: after fresh");
    const rows = w.h.majhi.services.store.runs.forTask("ACM-1");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.stopReason).toBe("handoff");
  });
});

describe("two agents on one account", () => {
  it("run at once through the run manager without breaking each other", async () => {
    await world({ slowMs: 20 });
    const second = await w.h.cmd("agents.create", {
      id: "acme-helper",
      frontmatter: { scope: "acme", role: "Builder", account: "claude-acme", perms: ["edit", "shell"] },
      instructions: "Help.\n",
    });
    expect(second.status).toBe(200);
    const a = await w.h.cmd("tasks.create", { text: "fix api", start: true });
    const b = await w.h.cmd("tasks.create", { text: "tidy api @acme-helper", start: true });
    expect([a.status, b.status]).toEqual([200, 200]);
    // Both are in a turn at the same time.
    for (let i = 0; i < 200 && runs().turnsInFlight() < 2; i++) await new Promise((r) => setTimeout(r, 5));
    expect(runs().turnsInFlight()).toBe(2);
    await runs().idle();

    for (const [task, agent] of [
      ["ACM-1", "acme-builder"],
      ["ACM-2", "acme-helper"],
    ] as const) {
      expect(live(agent, task)?.status).toBe("idle");
      const said = (await items(task)).flatMap((i) => (i.type === "agent" ? [i.text] : []));
      expect(said.at(-1)).toContain("Created HEALTH.md.");
      expect(await readFile(join(w.taskDir(task), "HEALTH.md"), "utf8")).toBe("# Health\n\nok\n");
    }
    // One config home for the account, shared by both processes.
    const homes = w.h.runtime.starts.map((s) => s.account.home);
    expect(new Set(homes).size).toBe(1);
    // A second message to each still works: neither session was broken by the other.
    await send("echo: one", "ACM-1");
    await send("echo: two", "ACM-2");
    expect((await items("ACM-2")).flatMap((i) => (i.type === "agent" ? [i.text] : [])).at(-1)).toBe(
      "echo: echo: two",
    );
  });
});
