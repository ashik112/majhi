import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { Script } from "../testing/fakeSession.ts";
import type { Harness } from "../testing/harness.ts";
import { taskWorld, type World } from "../testing/world.ts";

/**
 * An account's usage limit (SPEC 5.7): the agent's fallback takes over, or the run pauses and
 * continues at the reset. In-memory sessions, a fake clock, and the CLI's own limit line.
 */

let w: World;
afterEach(() => w?.cleanup());

const until = async (check: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  for (let i = 0; i < 600; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const START = Date.parse("2026-10-01T11:20:00.000Z");
const HOUR = 3_600_000;

function clockKit() {
  let t = START;
  return {
    clock: () => new Date(t),
    pass: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

/** What Claude Code prints when a login account is out: the reset as an epoch after a bar. */
const limitLine = (resetsAtMs: number) => `Claude AI usage limit reached|${Math.floor(resetsAtMs / 1000)}`;
const limited =
  (resetsAtMs: number): Script =>
  async () => {
    throw new Error(limitLine(resetsAtMs));
  };

interface Options {
  /** The builder's fallback is `acme-backup`, on its own account. */
  fallback?: boolean;
  org?: Record<string, unknown>;
}

/** Acme with `acme-builder` (account claude-acme) and `acme-backup` (account claude-acme-2). */
async function world(kit: ReturnType<typeof clockKit>, options: Options = {}): Promise<World> {
  w = await taskWorld({ runClock: kit.clock });
  const ok = async (name: string, body: unknown) => {
    const res = await w.h.cmd(name, body);
    if (res.status !== 200) throw new Error(`${name} failed: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  await ok("accounts.create", { id: "claude-acme-2", tool: "claude", org: "acme", auth: "login" });
  await ok("agents.create", {
    id: "acme-backup",
    frontmatter: { scope: "acme", role: "Builder", account: "claude-acme-2", perms: ["edit", "shell"] },
    instructions: "Back things up.\n",
  });
  if (options.fallback !== false) {
    await ok("agents.edit", { id: "acme-builder", set: { fallback: "acme-backup" } });
  }
  if (options.org !== undefined) await ok("orgs.update", { id: "acme", ...options.org });
  return w;
}

const runtime = () => w.h.runtime;
const services = () => w.h.majhi.services;

/** The first session runs `first`; later sessions keep the default script. */
function scriptFirst(first: Script): void {
  runtime().onSession = (session) => {
    if (runtime().sessions.length === 0) session.script = first;
  };
}

async function startTask(): Promise<void> {
  const res = await w.h.cmd("tasks.create", {
    text: "fix api",
    repos: [{ project: "acme-api" }],
    start: true,
    agent: "acme-builder",
  });
  expect(res.status).toBe(200);
}

async function items(task = "ACM-1"): Promise<RoomItem[]> {
  services().room.flush(task);
  const page = await w.h.cmd("room.items", { task, limit: 500 });
  return [...(page.body.items as RoomItem[])].sort((a, b) => (a.at < b.at ? -1 : 1));
}
const systems = async () => (await items()).flatMap((i) => (i.type === "system" ? [i.text] : []));
const task = async () => (await w.h.cmd("tasks.get", { id: "ACM-1" })).body;
const account = async (id: string) =>
  (await w.h.cmd("accounts.list")).body.find((a: { id: string }) => a.id === id);
const promptText = (session: { prompts: { type: string; text?: string }[][] } | undefined, n = 0) =>
  (session?.prompts[n] ?? []).map((b) => (b.type === "text" ? b.text : "")).join("\n");
const paused = (list: RoomItem[]) => list.flatMap((i) => (i.type === "paused" ? [i] : []));

describe("the fallback takes over", () => {
  it("takes the agent's place at the checkpoint, with a note, and marks the account", async () => {
    const kit = clockKit();
    await world(kit);
    scriptFirst(limited(kit.now() + 2 * HOUR));
    await startTask();
    await until(
      () => runtime().sessions.length === 2 && runtime().sessions[1]?.prompts.length === 1,
      "the fallback's turn",
    );

    // The fallback sits where the builder sat, and the builder's session ended.
    expect((await task()).team).toEqual(["acme-backup"]);
    expect((await task()).status).not.toBe("paused");
    expect(runtime().sessions[0]?.closed).toBe(true);
    expect(await systems()).toContainEqual(
      expect.stringMatching(
        /^@acme-builder hit its usage limit \(resets \d{1,2}:\d{2} [AP]M\)\. @acme-backup continues from the checkpoint\.$/,
      ),
    );
    // The fallback starts from the handoff note and still has the task to do.
    const text = promptText(runtime().sessions[1]);
    expect(text).toContain("# Handoff note");
    expect(text).toContain("Read TASK.md");

    const marked = await account("claude-acme");
    expect(marked.status).toBe("at-limit");
    expect(marked.limit.until).toBe(new Date(kit.now() + 2 * HOUR).toISOString());
    expect(marked.limit.resetKnown).toBe(true);
  });

  it("takes over when the CLI ends the turn with its limit line as the answer", async () => {
    const kit = clockKit();
    await world(kit);
    scriptFirst(async (turn) => {
      turn.emit({ type: "text", messageId: "m", text: "You've hit your limit · resets 3pm (UTC)" });
      return "end_turn";
    });
    await startTask();
    await until(() => runtime().sessions[1]?.prompts.length === 1, "the fallback's turn");
    expect((await task()).team).toEqual(["acme-backup"]);
    expect((await account("claude-acme")).status).toBe("at-limit");
  });
});

describe("pausing for the reset", () => {
  it("pauses with the prompt queued when the agent has no fallback", async () => {
    const kit = clockKit();
    await world(kit, { fallback: false });
    scriptFirst(limited(kit.now() + 2 * HOUR));
    await startTask();
    await until(async () => (await task()).status === "paused", "the pause");

    expect((await task()).pausedReason).toBe("limit");
    expect((await task()).team).toEqual(["acme-builder"]);
    const card = paused(await items())[0];
    expect(card?.why).toMatch(/^claude-acme is at its usage limit until \d{1,2}:\d{2} [AP]M$/);
    expect(runtime().sessions).toHaveLength(1);
    expect((await account("claude-acme")).status).toBe("at-limit");
  });

  it("pauses when the fallback's account is at its limit too", async () => {
    const kit = clockKit();
    await world(kit);
    await services().accounts.markLimit("claude-acme-2", {
      detail: "Claude AI usage limit reached",
      resetsAt: new Date(kit.now() + 3 * HOUR).toISOString(),
    });
    scriptFirst(limited(kit.now() + 2 * HOUR));
    await startTask();
    await until(async () => (await task()).status === "paused", "the pause");
    expect((await task()).pausedReason).toBe("limit");
    expect((await task()).team).toEqual(["acme-builder"]);
    expect(runtime().sessions).toHaveLength(1);
  });

  it("pauses instead of handing off when the org turned the handoff off", async () => {
    const kit = clockKit();
    await world(kit, { org: { resume: { handoff: false } } });
    scriptFirst(limited(kit.now() + 2 * HOUR));
    await startTask();
    await until(async () => (await task()).status === "paused", "the pause");
    expect((await task()).pausedReason).toBe("limit");
    expect((await task()).team).toEqual(["acme-builder"]);
    expect(runtime().sessions).toHaveLength(1);
  });

  it("continues at the reset with the same prompt", async () => {
    const kit = clockKit();
    await world(kit, { fallback: false });
    scriptFirst(limited(kit.now() + 2 * HOUR));
    await startTask();
    await until(async () => (await task()).status === "paused", "the pause");
    const first = promptText(runtime().sessions[0]);

    // Before the reset the sweep leaves it alone.
    kit.pass(HOUR);
    await services().budgets.lift();
    expect((await task()).status).toBe("paused");

    kit.pass(HOUR + 60_000);
    await services().budgets.lift();
    await until(
      () => runtime().sessions.length === 2 && runtime().sessions[1]?.prompts.length === 1,
      "the resumed turn",
    );
    expect(promptText(runtime().sessions[1])).toContain("Read TASK.md");
    expect(first).toContain("Read TASK.md");
    await until(async () => (await task()).status !== "paused", "the task running again");
    expect((await account("claude-acme")).status).not.toBe("at-limit");
  });

  it("waits for the owner at the reset when the org turned automatic resume off, and says so once", async () => {
    const kit = clockKit();
    await world(kit, { fallback: false, org: { resume: { auto: false } } });
    scriptFirst(limited(kit.now() + 2 * HOUR));
    await startTask();
    await until(async () => (await task()).status === "paused", "the pause");

    kit.pass(2 * HOUR + 60_000);
    await services().budgets.lift();
    await services().budgets.lift();
    expect((await task()).status).toBe("paused");
    expect(runtime().sessions).toHaveLength(1);
    const said = (await systems()).filter((t) => t.includes("Automatic resume is off for this org"));
    expect(said).toEqual([
      "claude-acme's limit reset. Automatic resume is off for this org, so resume the task when you are ready.",
    ]);

    // The owner's own resume still works.
    expect((await w.h.cmd("tasks.start", { id: "ACM-1" })).status).toBe(200);
    await until(() => runtime().sessions[1]?.prompts.length === 1, "the owner's resume");
  });
});

describe("a second agent on the account", () => {
  it("pauses before its turn while the account is at its limit", async () => {
    const kit = clockKit();
    await world(kit, { fallback: false });
    scriptFirst(limited(kit.now() + 2 * HOUR));
    await startTask();
    await until(async () => (await task()).status === "paused", "the pause");

    // Another agent on claude-acme gets work: it must not spend a turn on a limited account.
    expect(
      (
        await w.h.cmd("agents.create", {
          id: "acme-second",
          frontmatter: { scope: "acme", role: "Builder", account: "claude-acme", perms: ["edit"] },
          instructions: "Help.\n",
        })
      ).status,
    ).toBe(200);
    const added = await w.h.cmd("tasks.addAgent", { id: "ACM-1", agent: "acme-second" });
    expect(added.status).toBe(200);
    const sent = await w.h.cmd("room.send", {
      task: "ACM-1",
      text: "@acme-second please look",
      to: "acme-second",
    });
    expect(sent.status).toBe(200);
    await services().runs.idle();
    await until(
      () =>
        services()
          .runs.pausedForLimit()
          .some((r) => r.agent === "acme-second"),
      "its pause",
    );
    expect(runtime().sessions).toHaveLength(1);
    expect(
      services()
        .runs.pausedForLimit()
        .find((r) => r.agent === "acme-second")?.account,
    ).toBe("claude-acme");
  });
});

/** Keeps the type used: the harness the helpers above rely on. */
export type { Harness };
