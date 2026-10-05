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
  expect(
    (await w.h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true }))
      .status,
  ).toBe(200);
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
  });
});
