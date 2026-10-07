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

async function create(text: string, agent?: string): Promise<string> {
  const project = text.includes(" web ") ? "globex-web" : "acme-api";
  const res = await w.h.cmd("tasks.create", {
    text,
    repos: [{ project, base: "develop" }],
    start: true,
    ...(agent === undefined ? {} : { agent }),
  });
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

  it("lets the turn in progress finish, and holds the prompts queued behind it", async () => {
    await world(120);
    const id = await create("add a health endpoint to api from develop");
    await settle();
    expect(await turns(id)).toBe(1);

    // Turn 2 starts and is in progress; a third prompt waits behind it. Then the budget drops
    // below what is already used, so the 100% alert fires at once. Turn 2 must be a real, slow turn:
    // the fake agent answers an `echo:` prompt at once, so only a plain prompt runs the scripted
    // turn that `slowMs` stretches.
    await w.h.cmd("room.send", { task: id, text: "also add a version field" });
    await until(() => services().runs.working(id).length > 0, "turn 2 to start");
    await w.h.cmd("room.send", { task: id, text: "echo: third" });
    expect((await budget({ orgs: { acme: { tokens: TURN } } })).status).toBe(200);
    expect(services().runs.working(id).length).toBeGreaterThan(0);
    await settle();

    // Turn 2 ran to the end and was recorded; turn 3 did not start.
    expect(await turns(id)).toBe(2);
    const page = await w.h.cmd("room.items", { task: id, limit: 500 });
    const texts = (page.body.items as RoomItem[]).flatMap((i) => (i.type === "agent" ? [i.text] : []));
    expect(texts.join("\n")).not.toContain("echo: third");
    expect(task(id)).toMatchObject({ status: "paused", pausedReason: "limit" });
    expect(services().runs.pausedForLimit()).toEqual([{ task: id, agent: "acme-builder" }]);
  });
});
