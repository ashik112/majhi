import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CaptainAction, CaptainStatus, RoomItem, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { git } from "../testing/fixtures.ts";
import { ASK, RUNS, TIDY } from "./authority-fixtures.ts";

/**
 * Phase 13's "Done when" (SPEC 7): with Private on "Runs it" and a client on "Only when I ask", a
 * night ships Private's ready work within its budget and touches nothing of the client's. Real
 * services, git repos and the fake agent runtime; no tokens are spent.
 */

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

describe("a night with the captain deciding in Private and asking about everything in Acme", () => {
  it("ships Private's ready task, leaves Acme's alone, logs why with Undo, and asks before shipping in a tidy workspace", async () => {
    let now = new Date("2026-10-03T01:00:00.000Z");
    w = await bossWorld({ real: false, runClock: () => now });
    const world = w;
    const { h } = world;
    const must = (res: { status: number; body: unknown }) => {
      if (res.status !== 200) throw new Error(JSON.stringify(res.body));
      return res.body;
    };
    await world.addRepo("notes");
    must(await h.cmd("projects.register", { id: "notes", org: "private", path: "~/Work/notes" }));
    must(
      await h.cmd("autonomy.configure", {
        tz: "UTC",
        orgs: {
          private: { authority: { ...RUNS, merge: "decide" }, cap: { cost: 5 } },
          acme: { authority: ASK },
        },
      }),
    );
    must(await h.cmd("autonomy.start"));

    // Each agent commits one file in the task's first repo, then ends its turn.
    h.runtime.onSession = (session, start) => {
      session.script = async (t) => {
        const task = h.majhi.services.store.tasks.get(start.task ?? "");
        const repo = task?.repos[0];
        if (task !== undefined && repo !== undefined)
          await writeFile(join(task.folder, repo.project, "night.txt"), "done at night\n");
        t.emit({ type: "text", messageId: "m", text: "Done." });
        return "end_turn";
      };
    };
    const own = must(
      await h.cmd("tasks.create", { text: "Tidy the notes", repos: [{ project: "notes" }], start: true }),
    ) as Task;
    const client = must(
      await h.cmd("tasks.create", { text: "Fix the api", repos: [{ project: "acme-api" }], start: true }),
    ) as Task;
    await h.majhi.services.runs.idle();
    const task = (id: string) => h.majhi.services.store.tasks.get(id);
    expect(task(own.id)?.status).toBe("review");
    expect(task(client.id)?.status).toBe("review");
    const acmeMain = await git(world.repo("api"), "rev-parse", "main");

    // The owner types in the task: the captain waits.
    const captain = h.majhi.services.captain;
    const tab = {};
    h.majhi.services.events.typing.report(tab, own.id);
    await captain.runner.start("private", "ship", "Hourly check");
    expect(task(own.id)?.status).toBe("review");
    h.majhi.services.events.typing.report(tab, undefined);

    // Later that night.
    now = new Date("2026-10-03T01:30:00.000Z");
    await captain.sweepNow();
    await captain.settled();

    expect(task(own.id)?.status).toBe("done");
    expect(await git(world.repo("notes"), "show", "main:night.txt")).toBe("done at night");
    // Nothing of Acme's: still in review, its main where it was, no run and no log line there.
    expect(task(client.id)?.status).toBe("review");
    expect(await git(world.repo("api"), "rev-parse", "main")).toBe(acmeMain);
    const log = must(await h.cmd("captain.log", { limit: 200 })) as {
      actions: CaptainAction[];
      runs: { org: string }[];
    };
    expect(log.actions.filter((a) => a.org === "acme")).toEqual([]);
    expect(log.runs.filter((r) => r.org === "acme")).toEqual([]);
    const shipped = log.actions.find((a) => a.chore === "ship" && a.outcome === "done");
    expect(shipped).toMatchObject({
      org: "private",
      task: own.id,
      text: `Shipped ${own.id} to main: Tidy the notes`,
      reason: "In Private the captain decides when work is merged",
      evidence:
        "committed, merges cleanly into main, no card waits, no secret in the diff; no test command, not tested, review not run",
      undo: "yes",
    });
    // Within its budget: the night spent nothing on tokens here.
    const status = must(await h.cmd("captain.status")) as CaptainStatus;
    const priv = status.orgs.find((o) => o.org === "private");
    expect(priv).toMatchObject({
      authority: { start: "decide", upkeep: "decide", merge: "decide" },
      effective: { start: "decide", upkeep: "decide", merge: "decide" },
      // The owner checklist asks about the backup this world never made.
      summary: "shipped 1, 2 things for you",
      budget: { cost: 5 },
    });
    expect(priv?.used.cost ?? 0).toBeLessThanOrEqual(5);
    expect(status.orgs.find((o) => o.org === "acme")).toMatchObject({
      authority: { start: "ask", upkeep: "ask", merge: "ask" },
      effective: { start: "ask", upkeep: "ask", merge: "ask" },
      summary: "",
    });

    // Undo: a revert commit on main, the task's file gone, the history kept.
    const merged = await git(world.repo("notes"), "rev-parse", "main");
    must(await h.cmd("captain.undo", { id: shipped?.id }));
    expect(await git(world.repo("notes"), "rev-parse", "main^")).toBe(merged);
    await expect(git(world.repo("notes"), "show", "main:night.txt")).rejects.toThrow();
    expect((await h.cmd("captain.undo", { id: shipped?.id })).status).toBe(409);

    // Acme set to Keeps things tidy: the captain asks on the review card and ships nothing.
    must(await h.cmd("autonomy.configure", { orgs: { acme: { authority: TIDY } } }));
    now = new Date("2026-10-03T03:00:00.000Z");
    await captain.runner.start("acme", "ship", "Hourly check");
    await captain.settled();
    expect(task(client.id)?.status).toBe("review");
    expect(await git(world.repo("api"), "rev-parse", "main")).toBe(acmeMain);
    const items = must(await h.cmd("room.items", { task: client.id, limit: 200 })) as { items: RoomItem[] };
    const review = items.items.find((i) => i.type === "review" && i.state === "pending");
    expect(review).toMatchObject({
      ready:
        "Ready to ship to main: committed, merges cleanly into main, no card waits, no secret in the diff. In Acme you decide when work is merged, so the captain asks before shipping.",
    });
    const pending = must(await h.cmd("notify.pending")) as { task: string; text: string }[];
    expect(pending).toContainEqual(
      expect.objectContaining({ task: client.id, text: `${client.id} is ready to ship` }),
    );
  });
});
