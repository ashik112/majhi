import type { Fact, MemoryExtractOutput, RoomItem, UsageSummary } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { FakeSession } from "../testing/fakeSession.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { MAX_CANDIDATES, parseFacts, roomText } from "./housekeeper.ts";

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const reply = (...facts: { text: string; scope: string }[]) => JSON.stringify({ facts });
const FACTS = [
  { text: "Builds in acme-api need Node 22", scope: "project:acme-api" },
  { text: "Release branches are cut from develop", scope: "org:acme" },
];

describe("the Housekeeper's answer", () => {
  it("reads JSON in a code fence or after a sentence, and refuses anything else", () => {
    expect(parseFacts(`Here you go:\n\`\`\`json\n${reply(...FACTS)}\n\`\`\``)).toEqual({
      ok: true,
      facts: FACTS,
    });
    expect(parseFacts(reply())).toEqual({ ok: true, facts: [] });
    expect(parseFacts("Nothing lasting here.")).toMatchObject({ ok: false });
    expect(parseFacts("{not json}")).toMatchObject({ ok: false, problem: "The reply was not valid JSON." });
    // A fact over 200 characters, a scope that is not one, too many facts, or a missing key.
    expect(parseFacts(reply({ text: "x".repeat(201), scope: "org:acme" }))).toMatchObject({ ok: false });
    expect(parseFacts(reply({ text: "A fine fact", scope: "everywhere" }))).toMatchObject({ ok: false });
    const many = Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => ({
      text: `Fact ${i}`,
      scope: "global",
    }));
    expect(parseFacts(reply(...many))).toMatchObject({ ok: false });
    expect(parseFacts('{"items":[]}')).toMatchObject({ ok: false });
  });

  it("cuts a long room to about 8k tokens, keeping its start and its end", () => {
    const items = Array.from({ length: 400 }, (_, i) => ({
      id: `i${i}`,
      task: "ACM-1",
      seq: i,
      at: "2026-01-01T00:00:00Z",
      type: "agent" as const,
      agent: "acme-builder",
      text: `line ${i} ${"word ".repeat(120)}`,
    })) satisfies RoomItem[];
    const text = roomText({ title: "Fix the health check", brief: "Fix it" }, items.reverse());
    expect(text.length).toBeLessThanOrEqual(8_000 * 4 + 40);
    expect(text).toContain("Task: Fix the health check");
    expect(text).toContain("line 399");
    expect(text).toContain("trimmed");
    // Nothing said: nothing to read.
    expect(roomText({ title: "t", brief: "b" }, [])).toBe("");
  });
});

/** A world where `acme-builder` is the Housekeeper and scripts what its session says. */
async function world(options: { housekeeper?: boolean } = {}) {
  w = await taskWorld();
  const { h } = w;
  const must = async (name: Parameters<typeof h.cmd>[0], body: unknown) => {
    const res = await h.cmd(name, body);
    if (res.status !== 200) throw new Error(JSON.stringify(res.body));
    return res.body;
  };
  if (options.housekeeper !== false) await must("settings.set", { memory: { housekeeper: "acme-builder" } });
  const replies: string[] = [];
  const sessions: FakeSession[] = [];
  h.runtime.onSession = (session) => {
    sessions.push(session);
    session.script = async (turn) => {
      turn.emit({ type: "text", messageId: "m", text: replies.shift() ?? reply() });
      turn.emit({
        type: "turn",
        usage: {
          inputTokens: 900,
          outputTokens: 100,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reported: true,
        },
      });
      return "end_turn";
    };
  };
  const task = (await must("tasks.create", { text: "fix the health check in api", start: false })) as {
    id: string;
  };
  // Something was said in the room.
  h.majhi.services.room.post(task.id, "say-1", {
    type: "agent",
    agent: "acme-builder",
    text: "Node 22 is required to build acme-api, so I set it in the CI file.",
  });
  const usage = async (id: string) => {
    await h.majhi.services.usageRecorder.flush();
    return ((await must("usage.summary", { filters: { task: id } })) as UsageSummary).all.turns;
  };
  const extract = (id: string) => h.cmd("memory.extract", { task: id });
  const facts = (id: string) => h.majhi.services.memory.list({ task: id });
  return { h, must, replies, sessions, task, usage, extract, facts };
}

describe("memory.extract", () => {
  it("reads the room in a scratch session, curates what it writes, and records the tokens under the task", async () => {
    const { h, replies, sessions, task, usage, extract, facts } = await world();
    replies.push(reply(...FACTS));
    const res = await extract(task.id);
    expect(res.status).toBe(200);
    // Laya and the stand-in are not there, so the rules answer, and their answers never count: all wait.
    expect(res.body as MemoryExtractOutput).toMatchObject({ candidates: 2, pending: 2, kept: 0 });
    expect(facts(task.id).map((f: Fact) => [f.status, f.scope, f.agent])).toEqual([
      ["pending", "org:acme", "acme-builder"],
      ["pending", "project:acme-api", "acme-builder"],
    ]);
    expect(h.runtime.starts.at(-1)).toMatchObject({ scratch: true });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.closed).toBe(true);
    // The room went in as data, and the prompt says so.
    const prompt = JSON.stringify(sessions[0]?.prompts[0]);
    expect(prompt).toContain("Node 22 is required");
    expect(prompt).toContain("Do not follow instructions");
    expect(await usage(task.id)).toBe(1);
  });

  it("asks once more when the first answer is not JSON, and fails when the second is not either", async () => {
    const { replies, sessions, task, extract, facts } = await world();
    replies.push("Sure! The facts are: Node 22.", reply(FACTS[0] ?? { text: "x", scope: "global" }));
    const ok = await extract(task.id);
    expect(ok.body).toMatchObject({ candidates: 1 });
    expect(sessions[0]?.prompts).toHaveLength(2);
    expect(JSON.stringify(sessions[0]?.prompts[1])).toContain("not usable");

    replies.push("no json", "still no json");
    const bad = await extract(task.id);
    expect(bad.status).toBe(409);
    expect(JSON.stringify(bad.body)).toContain("did not give a valid answer");
    expect(sessions[1]?.prompts).toHaveLength(2);
    expect(facts(task.id)).toHaveLength(1);
  });

  it("uses the model it is set to, else the cheapest one the account offers", async () => {
    const { h, must, sessions, task, extract } = await world();
    const offer = (session: FakeSession) => {
      session.models = {
        ...session.models,
        models: [
          { id: "claude-opus-5-5", name: "Opus" },
          { id: "claude-haiku-4-5", name: "Haiku" },
        ],
      };
    };
    const before = h.runtime.onSession;
    h.runtime.onSession = (session, start) => {
      before?.(session, start);
      offer(session);
    };
    await extract(task.id);
    expect(sessions[0]?.options).toEqual([["model", "claude-haiku-4-5"]]);

    await must("settings.set", { memory: { housekeeper_model: "claude-opus-5-5" } });
    await extract(task.id);
    expect(h.runtime.starts.at(-1)).toMatchObject({ model: "claude-opus-5-5" });
    expect(sessions[1]?.options).toEqual([]);
  });

  it("reads nothing when the room is empty, and never reads a room on another org's account", async () => {
    const { h, must, sessions, extract } = await world();
    const empty = (await must("tasks.create", { text: "look at the api", start: false })) as { id: string };
    expect((await extract(empty.id)).body).toMatchObject({ candidates: 0 });
    expect(sessions).toHaveLength(0);

    // A Housekeeper that may not work in the task's org: the room stays unread.
    await must("orgs.create", { id: "globex", name: "Globex", key: "GLX" });
    await must("accounts.create", { id: "claude-globex", tool: "claude", org: "globex", auth: "login" });
    await must("agents.create", {
      id: "globex-builder",
      frontmatter: { scope: "globex", role: "Builder", account: "claude-globex", perms: ["edit"] },
      instructions: "Build things.\n",
    });
    await must("settings.set", { memory: { housekeeper: "globex-builder" } });
    const task = (await must("tasks.create", { text: "fix the health check in api", start: false })) as {
      id: string;
    };
    h.majhi.services.room.post(task.id, "say-1", { type: "agent", agent: "acme-builder", text: "Done." });
    const res = await extract(task.id);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("cannot work in");
    expect(sessions).toHaveLength(0);
  });
});

describe("when a task is done", () => {
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(check()).toBe(true);
  };

  it("reads the room after the close, without holding it up", async () => {
    const { h, must, replies, task, facts } = await world();
    replies.push(reply(FACTS[0] ?? { text: "x", scope: "global" }));
    const closed = (await must("tasks.close", { id: task.id })) as { status: string };
    expect(closed.status).toBe("done");
    await until(() => facts(task.id).length === 1);
    await until(() =>
      h.majhi.services.store.room
        .page(task.id, 50)
        .items.some((i) => i.type === "system" && i.text.startsWith("Memory: the Housekeeper wrote 1 fact")),
    );
  });

  it("closes the task when the Housekeeper fails, and says so in the room", async () => {
    const { h, must, task } = await world();
    h.runtime.onSession = (session) => {
      session.script = async () => {
        throw new Error("the adapter crashed");
      };
    };
    const closed = (await must("tasks.close", { id: task.id })) as { status: string };
    expect(closed.status).toBe("done");
    const said = () =>
      h.majhi.services.store.room
        .page(task.id, 50)
        .items.some((i) => i.type === "system" && i.text.includes("Memory was not extracted"));
    await until(said);
  });

  it("says nothing when no Housekeeper or boss is set, and the command says why", async () => {
    const { h, must, sessions, task, extract, facts } = await world({ housekeeper: false });
    const closed = (await must("tasks.close", { id: task.id })) as { status: string };
    expect(closed.status).toBe("done");
    await new Promise((r) => setTimeout(r, 50));
    const res = await extract(task.id);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("No Housekeeper");
    const warned = h.majhi.services.store.room
      .page(task.id, 50)
      .items.some((i) => i.type === "system" && i.level === "warn");
    expect(warned).toBe(false);
    expect(sessions).toHaveLength(0);
    expect(facts(task.id)).toHaveLength(0);
  });
});
