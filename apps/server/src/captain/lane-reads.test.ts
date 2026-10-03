import { AGENT_BLOCKED_COMMANDS, type CommandName, commands, type Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { toolName } from "../admin/tools.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { UsageRepo } from "../usage/repo.ts";
import { RUNS, TIDY } from "./authority-fixtures.ts";

/**
 * A captain lane reads one workspace only (5.18). Globex is filled with a task, a project, an
 * account, an agent, a memory, an audit row, spend and settings; then Acme's lane calls every read
 * command an agent may call, found from the command table, not a list kept by hand. No answer may
 * name Globex or a Private task, and an explicit filter for Globex is refused.
 */

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

/** Words that only Globex's or Private's rows hold. */
const FOREIGN = [/globex/i, /\bGLX-\d/, /\bLOCAL-\d/, /claude-other/];

async function world() {
  w = await bossWorld({ real: false });
  const world = w;
  const { h } = world;
  const must = async (cmd: Promise<{ status: number; body: unknown }>) => {
    const res = await cmd;
    if (res.status !== 200) throw new Error(JSON.stringify(res.body));
    return res.body;
  };
  await must(h.cmd("orgs.create", { id: "globex", name: "Globex", key: "GLX" }));
  await must(h.cmd("accounts.create", { id: "claude-globex", tool: "claude", org: "globex", auth: "login" }));
  await must(h.cmd("accounts.create", { id: "claude-other", tool: "claude", org: "private", auth: "login" }));
  await must(
    h.cmd("agents.create", {
      id: "globex-builder",
      frontmatter: {
        scope: "globex",
        role: "Builder",
        account: "claude-globex",
        model: "sonnet",
        effort: "high",
        perms: ["edit"],
      },
      instructions: "Build.\n",
    }),
  );
  await world.addRepo("web");
  await must(h.cmd("projects.register", { id: "globex-web", org: "globex", path: "~/Work/web" }));
  const glx = (await must(
    h.cmd("tasks.create", { text: "Globex pricing page", repos: [{ project: "globex-web" }], start: false }),
  )) as Task;
  const own = (await must(h.cmd("tasks.create", { text: "Private notes", start: false }))) as Task;
  const acme = (await must(
    h.cmd("tasks.create", { text: "Fix the api", repos: [{ project: "acme-api" }], start: false }),
  )) as Task;
  await must(
    h.cmd("memory.add", { text: "Globex invoices close on the 3rd", scope: "org:globex", pinned: false }),
  );
  await must(h.cmd("memory.add", { text: "Acme deploys on Tuesdays", scope: "org:acme", pinned: false }));
  await must(
    h.cmd("autonomy.configure", {
      orgs: {
        acme: { authority: RUNS },
        globex: { authority: TIDY, cap: { cost: 3 } },
        private: { authority: TIDY },
      },
    }),
  );
  const services = h.majhi.services;
  services.store.permissions.log({
    task: glx.id,
    agent: "globex-builder",
    kind: "tasks.push",
    title: "Push the Globex branch",
    decision: "allow",
    by: "owner",
    at: new Date().toISOString(),
  });
  const turn = (task: string, org: string | null, account: string) =>
    new UsageRepo(services.store.raw).insert({
      at: new Date().toISOString(),
      task,
      agent: "boss",
      account,
      tool: "claude",
      auth: "login",
      org,
      project: null,
      runId: null,
      model: null,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.5,
      costSource: "table",
      estimated: false,
    });
  turn(glx.id, "globex", "claude-globex");
  turn(acme.id, "acme", "claude-acme");
  turn(own.id, null, "claude-other");
  const lane = (await services.lanes.ensure("acme")).id;
  const call = (command: string, input: Record<string, unknown>) =>
    services.admin.call({ task: lane, agent: "boss" }, toolName(command), { reason: "reading", ...input });
  return { h, glx, own, acme, lane, call };
}

/** A minimal input for a read command: none, or a search word. */
function inputFor(command: CommandName): Record<string, unknown> | undefined {
  for (const input of [{}, { query: "invoices" }, { q: "invoices" }, { text: "invoices" }]) {
    if (commands[command].input.safeParse(input).success) return input;
  }
  return undefined;
}

describe("a captain lane's reads", () => {
  it("never show another workspace, for every read command an agent may call", async () => {
    const t = await world();
    const reads = (Object.keys(commands) as CommandName[]).filter(
      (c) => commands[c].risk === "read" && !AGENT_BLOCKED_COMMANDS.has(c),
    );
    const covered: string[] = [];
    const leaks: string[] = [];
    for (const command of reads) {
      const input = inputFor(command);
      if (input === undefined) continue;
      const res = await t.call(command, input);
      covered.push(command);
      if (res.isError) continue;
      const hit = FOREIGN.find((re) => re.test(res.text));
      if (hit !== undefined) leaks.push(`${command}: ${res.text.match(hit)?.[0]}`);
    }
    expect(leaks).toEqual([]);
    // The ones the owner named are among them.
    for (const c of [
      "tasks.list",
      "projects.list",
      "agents.list",
      "accounts.list",
      "orgs.list",
      "audit.list",
      "usage.summary",
      "usage.turns",
      "memory.search",
      "memory.list",
      "settings.get",
    ]) {
      if (c in commands) expect(covered, c).toContain(c);
    }
    expect(covered.length).toBeGreaterThan(30);
    // Its own workspace is still there.
    const tasks = await t.call("tasks.list", {});
    expect(tasks.text).toContain(t.acme.id);
    const memory = await t.call("memory.search", { query: "Tuesdays" });
    expect(memory.text).toContain("Acme deploys on Tuesdays");
  });

  it("keep the lane's own room whole, even where its text names another workspace's project", async () => {
    const t = await world();
    // An agent in Acme's task writes about Globex's project, as agents naming any word may.
    t.h.majhi.services.room.post(t.acme.id, "ask:own", {
      type: "ask",
      agent: "acme-builder",
      questions: [
        {
          id: "store_history",
          question:
            "The globex-web style checkpoints picked up the pnpm store. How should I clean the branch?",
          options: [{ id: "rebuild", label: "Rebuild the branch as one clean commit" }],
          freeText: false,
        },
      ],
      state: "pending",
    });
    const res = await t.call("room.items", { task: t.acme.id });
    expect(res.isError).toBe(false);
    const items = (JSON.parse(res.text) as { items: { id: string; questions?: { id: string }[] }[] }).items;
    expect(items.find((i) => i.id === "ask:own")?.questions?.map((q) => q.id)).toEqual(["store_history"]);
  });

  it("refuse an explicit filter for another workspace, and reads that name its task, project or room", async () => {
    const t = await world();
    const refused = (text: string) => expect(text).toMatch(/^Refused: this lane works in Acme only/);
    const cases: [string, Record<string, unknown>][] = [
      ["tasks.get", { id: t.glx.id }],
      ["tasks.get", { id: t.own.id }],
      ["room.items", { task: t.glx.id }],
      ["audit.list", { org: "globex" }],
      ["usage.summary", { filters: { org: "globex" } }],
      ["usage.turns", { filters: { account: "claude-globex" } }],
      ["memory.search", { query: "invoices", scope: "org:globex" }],
      ["projects.get", { id: "globex-web" }],
    ];
    for (const [command, input] of cases) {
      if (!(command in commands)) continue;
      const res = await t.call(command, input);
      expect(res.isError, `${command} ${JSON.stringify(input)}`).toBe(true);
      refused(res.text);
    }
    // Spend in the lane counts its own workspace only.
    const summary = JSON.parse((await t.call("usage.summary", {})).text) as { all: { costUsd: number } };
    expect(summary.all.costUsd).toBe(0.5);
  });
});
