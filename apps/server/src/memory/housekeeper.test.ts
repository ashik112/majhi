import type { TaskRecord, Thread, UsageSummary } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { FakeSession } from "../testing/fakeSession.ts";
import { taskWorld, type World } from "../testing/world.ts";

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const RECORD = {
  asked: "Fix the health check of the api.",
  done: "Changed src/health.ts so the check answers 200 when the database answers.",
  decisions: "Kept the route name so clients keep working.",
  outcome: "Merged into main.",
  left: "The readiness probe still points at the old route.",
};

interface Reply {
  record?: Partial<typeof RECORD>;
  threads?: { text: string; project?: string; follow_up?: string }[];
  closes?: number[];
  brief?: Record<string, Record<string, string>>;
  lessons?: { text: string; scope: string; happened?: string }[];
}
const reply = (r: Reply = {}) =>
  JSON.stringify({
    record: { ...RECORD, ...r.record },
    threads: r.threads ?? [],
    closes: r.closes ?? [],
    brief: r.brief ?? {},
    lessons: r.lessons ?? [],
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
  // Registering the project writes its card, and a by-itself pass then asks the Housekeeper for the
  // paragraph. Let that end before one is set, or its session lands among the ones a test counts.
  await until(() => h.majhi.services.cards.get("acme-api") !== undefined);
  await h.majhi.services.cards.idle();
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
  const newTask = async (text = "fix the health check in api", said = true) => {
    const task = (await must("tasks.create", { text, repos: [{ project: "acme-api" }], start: false })) as {
      id: string;
    };
    if (said) {
      h.majhi.services.room.post(task.id, `say-${task.id}`, {
        type: "agent",
        agent: "acme-builder",
        text: "The health check now answers 200 when the database answers. The readiness probe is left.",
      });
    }
    return task;
  };
  const task = await newTask();
  const usage = async (id: string) => {
    await h.majhi.services.usageRecorder.flush();
    return ((await must("usage.summary", { filters: { task: id } })) as UsageSummary).all.turns;
  };
  const extract = (id: string) => h.cmd("memory.extract", { task: id });
  const record = async (id: string) => (await must("memory.record", { task: id })) as TaskRecord | null;
  const threads = async (input: Record<string, unknown> = {}) =>
    (await must("memory.threads", input)) as Thread[];
  return { h, must, replies, sessions, task, newTask, usage, extract, record, threads };
}

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400 && !(await check()); i++) await new Promise((r) => setTimeout(r, 5));
  expect(await check()).toBe(true);
};

describe("memory.extract", () => {
  it("never reads a task on another org's account", async () => {
    const { h, must, sessions, task, extract, record } = await world();
    await must("orgs.create", { id: "globex", name: "Globex", key: "GLX" });
    await must("accounts.create", { id: "claude-globex", tool: "claude", org: "globex", auth: "login" });
    await must("agents.create", {
      id: "globex-builder",
      frontmatter: { scope: "globex", role: "Builder", account: "claude-globex", perms: ["edit"] },
      instructions: "Build things.\n",
    });
    await must("settings.set", { memory: { housekeeper: "globex-builder" } });
    const res = await extract(task.id);
    expect(res.status).toBe(409);
    expect(sessions).toHaveLength(0);
    expect(await record(task.id)).toBeNull();
    expect(h.majhi.services.memory.project.threads({})).toHaveLength(0);
  });

  it("never reads a task with a root agent on another org's account either", async () => {
    const { must, sessions, task, extract, record } = await world();
    await must("orgs.create", { id: "globex", name: "Globex", key: "GLX" });
    await must("accounts.create", { id: "claude-globex", tool: "claude", org: "globex", auth: "login" });
    // A root agent may work anywhere, but its account belongs to Globex: it does not pay for this task.
    await must("agents.create", {
      id: "root-on-globex",
      frontmatter: { scope: "root", role: "Root", account: "claude-globex", perms: ["edit"] },
      instructions: "Help.\n",
    });
    await must("settings.set", { memory: { housekeeper: "root-on-globex" } });
    const res = await extract(task.id);
    expect(res.status).toBe(409);
    expect(sessions).toHaveLength(0);
    expect(await record(task.id)).toBeNull();
  });
});

describe("when a task is done", () => {
  it("closes the task when the Housekeeper fails, and says so in the room", async () => {
    const { h, must, task } = await world();
    h.runtime.onSession = (session) => {
      session.script = async () => {
        throw new Error("the adapter crashed");
      };
    };
    const closed = (await must("tasks.close", { id: task.id })) as { status: string };
    expect(closed.status).toBe("done");
    await h.majhi.services.extraction.idle();
  });
});
