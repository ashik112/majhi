import { startSession } from "@majhi/acp";
import { fakeAdapter } from "@majhi/acp/testing";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

/** One fake turn is 1000 input + 200 output + 500 cache write = 1700 budget tokens. */
const TURN = 1700;

/**
 * Acme has two accounts and two agents (`acme-builder` on `claude-acme`, `acme-reviewer` on
 * `claude-acme-2`); Globex has one. Sessions run the real ACP engine against the fake adapter.
 */
async function world(slowMs = 0): Promise<World> {
  w = await taskWorld();
  const { h } = w;
  h.env.runtime.adapters = {
    claude: fakeAdapter("claude", { signedIn: true, usageModel: "claude-sonnet-5-5", slowMs }),
    codex: fakeAdapter("codex", { signedIn: true }),
  };
  h.runtime.startSession = (start) => startSession(start);
  const ok = async (name: string, body: unknown) => {
    const res = await h.cmd(name, body);
    if (res.status !== 200) throw new Error(`${name} failed: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  await ok("accounts.create", { id: "claude-acme-2", tool: "claude", org: "acme", auth: "login" });
  await ok("agents.create", {
    id: "acme-reviewer",
    frontmatter: { scope: "acme", role: "Builder", account: "claude-acme-2", perms: ["edit", "shell"] },
    instructions: "Review things.\n",
  });
  await ok("orgs.create", { id: "globex", name: "Globex", key: "GLX" });
  await ok("accounts.create", {
    id: "codex-globex",
    tool: "codex",
    org: "globex",
    auth: "api-key",
    apiKey: "test-key-globex-0000",
  });
  await ok("agents.create", {
    id: "globex-builder",
    frontmatter: { scope: "globex", role: "Builder", account: "codex-globex", perms: ["edit", "shell"] },
    instructions: "Build things.\n",
  });
  await w.addRepo("web");
  await ok("projects.register", { id: "globex-web", org: "globex", path: "~/Work/web", aliases: ["web"] });
  return w;
}

const services = () => w.h.majhi.services;
const settle = async () => {
  await services().runs.idle();
  await services().usageRecorder.flush();
};
const turns = async (task: string) =>
  ((await w.h.cmd("usage.turns", { filters: { task }, limit: 500 })).body as unknown[]).length;
const task = (id: string) => services().store.tasks.get(id);
const budget = (b: object) => w.h.cmd("settings.set", { budgets: b });

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !(await check()); i++) await new Promise((r) => setTimeout(r, 10));
  if (!(await check())) throw new Error(`Timed out waiting for ${what}`);
}

async function lines(id: string): Promise<string[]> {
  const page = await w.h.cmd("room.items", { task: id, limit: 500 });
  return (page.body.items as RoomItem[]).flatMap((i) => (i.type === "system" ? [i.text] : []));
}

async function create(text: string, agent?: string): Promise<string> {
  const res = await w.h.cmd("tasks.create", { text, start: true, ...(agent === undefined ? {} : { agent }) });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

describe("the 100% action", () => {
  it("pauses the runs of the org that is over, and not other orgs", async () => {
    await world();
    await budget({ orgs: { acme: { tokens: TURN } } });
    const acme = await create("add a health endpoint to api from develop");
    const globex = await create("add a health endpoint to web from develop", "globex-builder");
    await settle();
    expect(await turns(acme)).toBe(1);
    expect((await lines(acme)).some((l) => l.startsWith("Budget limit reached: org acme"))).toBe(true);

    // The next prompt in the org waits. The same goes for the org's other account.
    await w.h.cmd("room.send", { task: acme, text: "echo: and more" });
    await settle();
    expect(await turns(acme)).toBe(1);
    expect(task(acme)).toMatchObject({ status: "paused", pausedReason: "limit" });
    expect(services().runs.pausedForLimit()).toEqual([{ task: acme, agent: "acme-builder" }]);
    const other = await create("add a second endpoint to api from develop", "acme-reviewer");
    await settle();
    expect(await turns(other)).toBe(0);
    expect(task(other)).toMatchObject({ status: "paused", pausedReason: "limit" });

    // Globex has no budget: it runs on.
    await w.h.cmd("room.send", { task: globex, text: "echo: again" });
    await settle();
    expect(await turns(globex)).toBe(2);
    expect(task(globex)?.status).not.toBe("paused");
  });

  it("pauses the runs on the account that is over, and not the org's other account", async () => {
    await world();
    await budget({ accounts: { "claude-acme": { tokens: TURN } } });
    const builder = await create("add a health endpoint to api from develop");
    const reviewer = await create("add a second endpoint to api from develop", "acme-reviewer");
    await settle();
    expect(await turns(builder)).toBe(1);
    expect(await turns(reviewer)).toBe(1);
    await w.h.cmd("room.send", { task: builder, text: "echo: more" });
    await w.h.cmd("room.send", { task: reviewer, text: "echo: more" });
    await settle();
    expect(await turns(builder)).toBe(1);
    expect(task(builder)).toMatchObject({ status: "paused", pausedReason: "limit" });
    // The reviewer's run is on the other account and goes on. The over-budget account's agent is
    // paused wherever it is on a team, so ACM-2's builder waits (and the task shows paused with it).
    expect(await turns(reviewer)).toBe(2);
    const held = services().runs.pausedForLimit();
    expect(held.every((r) => r.agent === "acme-builder")).toBe(true);
    expect(held.map((r) => r.task)).toContain(builder);
  });

  it("lets the turn in progress finish, and holds the prompts queued behind it", async () => {
    await world(120);
    const id = await create("add a health endpoint to api from develop");
    await settle();
    expect(await turns(id)).toBe(1);

    // Turn 2 starts and is in progress; a third prompt waits behind it. Then the budget drops
    // below what is already used, so the 100% alert fires at once.
    await w.h.cmd("room.send", { task: id, text: "echo: second" });
    await until(() => services().runs.working(id).length > 0, "turn 2 to start");
    await w.h.cmd("room.send", { task: id, text: "echo: third" });
    expect((await budget({ orgs: { acme: { tokens: TURN } } })).status).toBe(200);
    expect(services().runs.working(id).length).toBeGreaterThan(0);
    await settle();

    // Turn 2 ran to the end and was recorded; turn 3 did not start.
    expect(await turns(id)).toBe(2);
    const page = await w.h.cmd("room.items", { task: id, limit: 500 });
    const texts = (page.body.items as RoomItem[]).flatMap((i) => (i.type === "agent" ? [i.text] : []));
    expect(texts.join("\n")).toContain("second");
    expect(task(id)).toMatchObject({ status: "paused", pausedReason: "limit" });
    expect(services().runs.pausedForLimit()).toEqual([{ task: id, agent: "acme-builder" }]);
  });
});

describe("lifting the pause", () => {
  /** Acme is over its budget and its one task is paused with a prompt waiting. */
  async function paused(): Promise<string> {
    await world();
    await budget({ orgs: { acme: { tokens: TURN } } });
    const id = await create("add a health endpoint to api from develop");
    await settle();
    await w.h.cmd("room.send", { task: id, text: "echo: waiting" });
    await settle();
    expect(await turns(id)).toBe(1);
    expect(task(id)).toMatchObject({ status: "paused", pausedReason: "limit" });
    return id;
  }

  it("lifts when the owner raises the budget above the use", async () => {
    const id = await paused();
    // Still under the use: nothing changes.
    await budget({ orgs: { acme: { tokens: TURN - 1 } } });
    await settle();
    expect(task(id)?.status).toBe("paused");
    await budget({ orgs: { acme: { tokens: TURN * 10 } } });
    await until(() => task(id)?.status === "running" || task(id)?.status === "review", "the task to run");
    await settle();
    expect(await turns(id)).toBe(2);
    expect(services().runs.pausedForLimit()).toEqual([]);
  });

  it("lifts when the owner resumes the task by hand, and does not pause it again that week", async () => {
    const id = await paused();
    expect((await w.h.cmd("tasks.start", { id })).status).toBe(200);
    await settle();
    expect(await turns(id)).toBeGreaterThan(1);
    expect(task(id)?.status).not.toBe("paused");
    const before = await turns(id);
    // More turns over the budget: no new threshold, so no new pause.
    await w.h.cmd("room.send", { task: id, text: "echo: more work" });
    await settle();
    expect(await turns(id)).toBeGreaterThan(before);
    expect(task(id)?.status).not.toBe("paused");
    expect(services().runs.pausedForLimit()).toEqual([]);
  });

  it("lifts when the week resets", async () => {
    const id = await paused();
    // The alert belongs to an earlier week now.
    services().store.raw.prepare("UPDATE budget_alerts SET week = '2020-01-06'").run();
    await services().budgets.lift();
    await until(() => task(id)?.status === "running" || task(id)?.status === "review", "the task to run");
    await settle();
    expect(await turns(id)).toBe(2);
  });

  it("lifts a task a restart left paused, with no run in memory, when the week resets", async () => {
    const id = await paused();
    // A restart: the store still says paused at budget, but no run is left in memory.
    services().runs.forget(id);
    expect(services().runs.pausedForLimit()).toEqual([]);
    // The budget still holds it: nothing starts.
    await services().budgets.lift();
    expect(task(id)).toMatchObject({ status: "paused", pausedReason: "limit" });
    services().store.raw.prepare("UPDATE budget_alerts SET week = '2020-01-06'").run();
    await services().budgets.lift();
    await until(() => task(id)?.status === "running" || task(id)?.status === "review", "the task to run");
    await settle();
    expect(task(id)?.status).not.toBe("paused");
  });
});
