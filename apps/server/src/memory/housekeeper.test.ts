import type {
  MemoryExtractOutput,
  ProjectBrief,
  TaskRecord,
  Thread,
  UsageSummary,
} from "@majhi/shared";
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
  it("writes the task record from the room and git in one scratch session, with its tokens under the task", async () => {
    const { h, replies, sessions, task, usage, extract, record } = await world();
    replies.push(reply());
    const res = await extract(task.id);
    expect(res.status).toBe(200);
    expect(res.body as MemoryExtractOutput).toMatchObject({ record: true, candidates: 0 });
    expect(await record(task.id)).toMatchObject({
      task: task.id,
      org: "acme",
      projects: ["acme-api"],
      ...RECORD,
      agent: "acme-builder",
      repos: [{ project: "acme-api", merged: false, commits: 0 }],
    });
    expect(h.runtime.starts.at(-1)).toMatchObject({ scratch: true });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.closed).toBe(true);
    // The room and git went in as data, and the prompt says so.
    const prompt = JSON.stringify(sessions[0]?.prompts[0]);
    expect(prompt).toContain("The readiness probe is left");
    expect(prompt).toContain("<git>");
    expect(await usage(task.id)).toBe(1);
  });

  it("asks once more when the first answer is not JSON, and fails when the second is not either", async () => {
    const { replies, sessions, task, extract, record } = await world();
    replies.push("Sure! It went fine.", reply());
    expect((await extract(task.id)).body).toMatchObject({ record: true });
    expect(sessions[0]?.prompts).toHaveLength(2);

    replies.push("no json", "still no json");
    const bad = await extract(task.id);
    expect(bad.status).toBe(409);
    // The record it had is still there.
    expect((await record(task.id))?.asked).toBe(RECORD.asked);
  });

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

  it("opens threads from what was left, and closes them by a later record, a done follow-up or by hand", async () => {
    const { h, must, replies, task, newTask, extract, threads } = await world();
    const follow = await newTask("add a timeout test to the api", false);
    h.majhi.services.store.tasks.putLink({ task: follow.id, type: "follow-up", other: task.id });
    replies.push(
      reply({
        threads: [
          { text: "Point the readiness probe at the new route", project: "acme-api" },
          { text: "Add a timeout test", project: "acme-api", follow_up: follow.id },
          // A follow-up id no task was made for is not linked.
          { text: "Clean up the old route", project: "acme-api", follow_up: "ACM-999" },
        ],
      }),
    );
    expect((await extract(task.id)).body).toMatchObject({ threads_opened: 3 });
    const open = await threads({ status: "open" });
    const probe = open.find((t) => t.text.startsWith("Point"));
    const timeout = open.find((t) => t.text.startsWith("Add"));
    const cleanup = open.find((t) => t.text.startsWith("Clean"));
    expect(timeout).toMatchObject({ task: task.id, project: "acme-api", follow_up: follow.id });
    expect(cleanup?.follow_up).toBeUndefined();

    // The follow-up is done: its thread closes, with no Housekeeper run (nobody worked in it).
    await must("tasks.close", { id: follow.id });
    expect(h.majhi.services.memory.project.thread(timeout?.id ?? 0)).toMatchObject({
      status: "closed",
      closed_by: `follow-up:${follow.id}`,
    });

    // A later task's record says the probe was done. A thread outside its projects stays open.
    const foreign = h.majhi.services.memory.project.openThread({
      text: "Globex web needs a new favicon",
      project: "globex-web",
      org: "globex",
      task: "GLX-1",
    });
    const later = await newTask("point the readiness probe of the api at the new route");
    replies.push(reply({ closes: [probe?.id ?? 0, foreign.id, 4242] }));
    expect((await extract(later.id)).body).toMatchObject({ threads_closed: 1 });
    expect(h.majhi.services.memory.project.thread(probe?.id ?? 0)).toMatchObject({
      status: "closed",
      closed_by: `task:${later.id}`,
    });
    expect(h.majhi.services.memory.project.thread(foreign.id)?.status).toBe("open");

    // By hand, and back.
    const closed = (await must("memory.closeThread", { id: cleanup?.id })) as Thread;
    expect(closed).toMatchObject({ status: "closed", closed_by: "owner" });
    expect((await h.cmd("memory.closeThread", { id: cleanup?.id })).status).toBe(409);
    expect(((await must("memory.reopenThread", { id: cleanup?.id })) as Thread).status).toBe("open");

    // Writing the first record again replaces its open threads, and keeps the closed ones.
    replies.push(reply({ threads: [{ text: "Clean up the old route", project: "acme-api" }] }));
    await extract(task.id);
    const mine = await threads({ task: task.id });
    expect(mine.filter((t) => t.status === "open").map((t) => t.text)).toEqual(["Clean up the old route"]);
    expect(mine.filter((t) => t.status === "closed")).toHaveLength(2);
  });

  it("patches the project brief after each record and keeps every version", async () => {
    const { must, replies, task, newTask, extract } = await world();
    replies.push(
      reply({
        brief: {
          "acme-api": {
            "What it is": "The Acme api.",
            Architecture: "Handlers in src/, health check in src/health.ts.",
            "Current state": "The health check answers 200.",
            "Plans and next steps": "Point the readiness probe at the new route.",
            "Known problems": "None known.",
          },
          // Not a project of the task: ignored.
          "globex-web": { "What it is": "Not Acme's." },
        },
      }),
    );
    expect((await extract(task.id)).body).toMatchObject({ briefs: ["acme-api"] });
    const later = await newTask("point the readiness probe of the api at the new route");
    replies.push(reply({ brief: { "acme-api": { "Current state": "The probe uses the new route." } } }));
    await extract(later.id);
    const { current, versions } = (await must("memory.brief", { project: "acme-api" })) as {
      current: ProjectBrief;
      versions: ProjectBrief[];
    };
    expect(versions.map((v) => [v.version, v.source, v.task])).toEqual([
      [2, "task", later.id],
      [1, "built", task.id],
    ]);
    expect(current.body).toContain("The probe uses the new route.");
    expect(current.body).toContain("Handlers in src/");
    expect(current.body).not.toContain("The health check answers 200.");
    expect(((await must("memory.brief", { project: "globex-web" })) as { versions: [] }).versions).toEqual(
      [],
    );

    // A patch that changes nothing adds no version.
    const third = await newTask("look at the api again");
    replies.push(reply({ brief: { "acme-api": { "Current state": "The probe uses the new route." } } }));
    expect((await extract(third.id)).body).toMatchObject({ briefs: [] });
  });

});

describe("when a task is done", () => {
  it("writes the record once, after the close, without holding it up", async () => {
    const { h, must, replies, sessions, task, record } = await world();
    replies.push(reply());
    const closed = (await must("tasks.close", { id: task.id })) as { status: string };
    expect(closed.status).toBe("done");
    await until(async () => (await record(task.id)) !== null);
    const first = await record(task.id);

    // Done again (a second close, a merge that closes it): nothing new is read or written.
    const extraction = h.majhi.services.extraction;
    const done = h.majhi.services.store.tasks.get(task.id);
    if (done === undefined) throw new Error("no task");
    extraction.afterClose(done);
    extraction.afterClose(done);
    await extraction.idle();
    expect(sessions).toHaveLength(1);
    expect(await record(task.id)).toEqual(first);

    // Asked by the owner, it is written again in place: still one record.
    replies.push(reply({ record: { outcome: "Merged into main at abc1234." } }));
    await must("memory.extract", { task: task.id });
    const again = await record(task.id);
    expect(again?.id).toBe(first?.id);
    expect(again?.outcome).toBe("Merged into main at abc1234.");
    expect(((await must("memory.records", {})) as unknown[]).length).toBe(1);
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
    await h.majhi.services.extraction.idle();
  });

});
