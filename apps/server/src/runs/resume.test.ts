import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { Script } from "../testing/fakeSession.ts";
import { git } from "../testing/fixtures.ts";
import type { Harness } from "../testing/harness.ts";
import { taskWorld, type World, type WorldOptions } from "../testing/world.ts";

/**
 * Resume without the owner (SPEC 5.7), concurrency limits and agents on demand (5.17), and the
 * decision hooks (5.12), with in-memory sessions.
 */

let w: World;
let extra: Harness | undefined;
afterEach(async () => {
  if (extra !== undefined) {
    await extra.majhi.services.runs.closeAll();
    await extra.majhi.close();
    extra = undefined;
  }
  await w?.cleanup();
});

const until = async (check: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  for (let i = 0; i < 600; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

/** A turn that writes a file into the worktree and then stays open until released or cancelled. */
function working(file: string): { script: Script; release: () => void } {
  let release: () => void = () => {};
  const open = new Promise<void>((r) => {
    release = r;
  });
  return {
    release: () => release(),
    script: async (turn) => {
      const wt = join(w.taskDir("ACM-1"), "acme-api");
      await mkdir(wt, { recursive: true });
      await writeFile(join(wt, file), "work\n");
      turn.emit({ type: "text", messageId: "m", text: "working" });
      await Promise.race([open, turn.untilCancelled()]);
      return "end_turn";
    },
  };
}

async function items(h: Harness, task = "ACM-1"): Promise<RoomItem[]> {
  h.majhi.services.room.flush(task);
  const page = await h.cmd("room.items", { task, limit: 500 });
  return [...(page.body.items as RoomItem[])].sort((a, b) => (a.at < b.at ? -1 : 1));
}
const systems = async (h: Harness, task = "ACM-1") =>
  (await items(h, task)).flatMap((i) => (i.type === "system" ? [i.text] : []));
const status = async (h: Harness, id = "ACM-1") => (await h.cmd("tasks.get", { id })).body;

/** Starts ACM-1 with its first turn scripted and waits until that turn is running. */
async function startWorking(options: WorldOptions = {}, file = "a.txt") {
  w = await taskWorld(options);
  const turn = working(file);
  w.h.runtime.onSession = (session) => {
    if (w.h.runtime.sessions.length === 0) session.script = turn.script;
  };
  expect((await w.h.cmd("tasks.create", { text: "fix api", start: true })).status).toBe(200);
  await until(() => existsSync(join(w.taskDir("ACM-1"), "acme-api", file)), "the first turn");
  return turn;
}

describe("restart and crash", () => {
  it("continues a cut turn after a restart, with its work and a checkpoint", async () => {
    await startWorking();
    // majhi dies mid-turn: a second server opens the same home without closing the first.
    extra = w.h.restart();
    const again = extra;
    await until(() => w.h.runtime.sessions.length === 2, "a new session");
    await again.majhi.services.runs.idle();

    const second = w.h.runtime.sessions[1];
    expect(w.h.runtime.starts[1]?.resume).toBe(w.h.runtime.sessions[0]?.sessionId);
    // The team facts block may follow; the resume line comes first.
    expect(second?.prompts[0]?.[0]).toEqual({
      type: "text",
      text: "Continue from where you stopped. There is no checkpoint yet.",
    });
    expect(await systems(again)).toContain("Resuming @acme-builder: majhi restarted during its turn.");
    // The work from before the crash is on disk and committed at the end of the resumed turn.
    const wt = join(w.taskDir("ACM-1"), "acme-api");
    expect(await git(wt, "log", "-1", "--format=%s")).toBe("wip(ACM-1): checkpoint 1");
    expect(await git(wt, "show", "--name-only", "--format=", "HEAD")).toBe("a.txt");
    expect(again.majhi.services.store.runs.interrupted()).toEqual([]);
    expect(again.majhi.services.store.runs.forTask("ACM-1").at(-1)?.checkpoint).toBe(1);
  });

  it("pauses with reason error after two failed resumes", async () => {
    await startWorking();
    w.h.runtime.startError = new Error("adapter is broken");
    extra = w.h.restart();
    const again = extra;
    await until(async () => (await status(again)).status === "paused", "the pause");
    expect(await status(again)).toMatchObject({ pausedReason: "error" });
    const text = await systems(again);
    expect(text.filter((t) => t.startsWith("@acme-builder could not start"))).toHaveLength(2);
    expect(text).toContain(
      "Could not resume @acme-builder after two tries: the agent could not start. Resume the task to try again.",
    );
  });
});

describe("offline", () => {
  it("pauses running turns when the network drops and resumes them when it returns, with the work intact", async () => {
    let online = true;
    const turn = await startWorking({ probe: async () => online });
    const { resilience, room } = w.h.majhi.services;
    online = false;
    await resilience.network.check();
    await until(async () => (await status(w.h)).status === "paused", "the offline pause");
    expect(await status(w.h)).toMatchObject({ pausedReason: "offline" });
    expect(room.getLive("ACM-1", "acme-builder")?.status).toBe("paused");
    expect(await systems(w.h)).toContain(
      "majhi is offline. @acme-builder paused and continues when the connection is back.",
    );
    // The cut turn does not say "Stopped", and its work was checkpointed.
    expect(await systems(w.h)).not.toContain("Stopped @acme-builder's turn.");
    const wt = join(w.taskDir("ACM-1"), "acme-api");
    await until(
      async () => (await git(wt, "log", "-1", "--format=%s")) === "wip(ACM-1): checkpoint 1",
      "the checkpoint",
    );

    online = true;
    await resilience.network.check();
    await until(() => (w.h.runtime.sessions[0]?.prompts.length ?? 0) === 2, "the resume prompt");
    turn.release();
    await w.h.majhi.services.runs.idle();
    // The same session continues: nothing was restarted.
    expect(w.h.runtime.sessions).toHaveLength(1);
    expect(w.h.runtime.sessions[0]?.prompts[1]).toEqual([
      { type: "text", text: "Continue from where you stopped. The last checkpoint is 1." },
    ]);
    expect((await status(w.h)).status).toBe("review");
    expect(existsSync(join(wt, "a.txt"))).toBe(true);
  });
});

describe("limits", () => {
  async function threeAgents(): Promise<void> {
    for (const id of ["acme-two", "acme-three"]) {
      const res = await w.h.cmd("agents.create", {
        id,
        frontmatter: { scope: "acme", role: "Builder", account: "claude-acme", perms: ["edit"] },
        instructions: "Build.\n",
      });
      expect(res.status).toBe(200);
    }
  }

  it("queues a third agent under per_account 2, shows its place, and starts it when a slot frees", async () => {
    w = await taskWorld();
    await threeAgents();
    // One open turn per task, released by the test.
    const gates = new Map<string, () => void>();
    w.h.runtime.onSession = (session, start) => {
      const task = start.cwd.split("/").pop() ?? "";
      session.script = (turn) =>
        new Promise((resolve) => {
          turn.emit({ type: "text", messageId: "m", text: "busy" });
          gates.set(task, () => resolve("end_turn"));
        });
    };
    for (const text of ["one on api", "two on api @acme-two", "three on api @acme-three"]) {
      expect((await w.h.cmd("tasks.create", { text, start: true })).status).toBe(200);
    }
    const live = (task: string, agent: string) => w.h.majhi.services.room.getLive(task, agent);
    await until(() => live("ACM-3", "acme-three")?.status === "queued", "the queue");
    expect(live("ACM-3", "acme-three")).toMatchObject({ status: "queued", slot: 1 });
    expect(w.h.runtime.sessions).toHaveLength(2);
    expect(await systems(w.h, "ACM-3")).toContain(
      "Queued, #1 in line: majhi is running as many agents as the limits allow. @acme-three starts when a slot is free.",
    );

    // The first agent ends its turn and goes idle: its process makes room for the one waiting.
    await until(() => gates.has("ACM-1"), "the first turn");
    gates.get("ACM-1")?.();
    await until(() => w.h.runtime.sessions.length === 3, "the third session");
    const first = w.h.runtime.sessions.find((s) =>
      w.h.runtime.starts[w.h.runtime.sessions.indexOf(s)]?.cwd.endsWith("ACM-1"),
    );
    expect(first?.closed).toBe(true);
    expect(live("ACM-1", "acme-builder")?.status).toBe("idle");
    expect(live("ACM-3", "acme-three")?.slot).toBeUndefined();
    await until(() => gates.has("ACM-3"), "the third turn");
    gates.get("ACM-2")?.();
    gates.get("ACM-3")?.();
    await w.h.majhi.services.runs.idle();
  });
});
