import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PendingShip, RoomItem, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { git, tempDir } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";

/**
 * "Resolve and merge": a ship that stopped on conflicts waits on the task until the lead's turn
 * ends, then runs once through the Ship path, or goes back to review with the reason.
 */

let w: World | undefined;
let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
  for (const c of cleanups) await c();
  cleanups = [];
});

const world = (): World => {
  if (w === undefined) throw new Error("no world");
  return w;
};
const cmd = (name: string, body?: unknown) => world().h.cmd(name, body);
const get = async (): Promise<Task> => (await cmd("tasks.get", { id: "ACM-1" })).body;
const items = async () => (await cmd("room.items", { task: "ACM-1", limit: 300 })).body.items as RoomItem[];
const notes = async () => (await items()).flatMap((i) => (i.type === "system" ? [i.text] : []));
const tree = () => join(world().taskDir("ACM-1"), "acme-api");
const tip = async (repo: string, ref: string) => (await git(repo, "rev-parse", ref)).trim();
const who = ["-c", "user.name=Builder", "-c", "user.email=builder@example.com"];

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** What the agent does on its next turn. */
let next: (prompt: string) => Promise<void>;

/** ACM-1 in review, its branch and main both changed shared.txt, and a merge that hit the conflict. */
async function conflicted(): Promise<void> {
  w = await taskWorld();
  next = async () => {
    await writeFile(join(tree(), "shared.txt"), "task side\n");
  };
  w.h.runtime.onSession = (session) => {
    session.script = async (t) => {
      await next(t.text);
      t.emit({ type: "text", messageId: `m-${Math.random()}`, text: "Done." });
      return "end_turn";
    };
  };
  expect(
    (await cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true })).status,
  ).toBe(200);
  await w.h.majhi.services.runs.idle();
  await until(async () => (await get()).status === "review", "review");
  await writeFile(join(w.repo("api"), "shared.txt"), "main side\n");
  await git(w.repo("api"), "add", "shared.txt");
  await git(w.repo("api"), ...who, "commit", "-qm", "main side");
  const merge = await cmd("tasks.merge", { id: "ACM-1", into: "main", done: true });
  expect(merge.body.results).toMatchObject([{ ok: false, conflicts: ["shared.txt"] }]);
}

/** The lead's resolution: merge main in, keep both sides, commit. */
async function resolve(): Promise<void> {
  await git(tree(), ...who, "merge", "-q", "main").catch(() => "");
  await writeFile(join(tree(), "shared.txt"), "main side\ntask side\n");
  await git(tree(), "add", "shared.txt");
  await git(tree(), ...who, "commit", "-q", "--no-edit");
}

describe("resolve and ship", () => {
  it("asks the lead, then merges by itself exactly once when the branch merges cleanly", async () => {
    await conflicted();
    const prompts: string[] = [];
    next = async (prompt) => {
      prompts.push(prompt);
      await resolve();
    };
    const res = await cmd("tasks.resolveShip", { id: "ACM-1", action: "merge", into: "main" });
    expect(res.status).toBe(200);
    expect(res.body.task.pendingShip).toMatchObject({
      action: "merge",
      into: "main",
      method: "merge",
      deleteAfter: false,
      lead: "acme-builder",
      by: "owner",
    });

    await until(async () => (await get()).status === "done", "the ship to run");
    expect((await get()).pendingShip).toBeUndefined();
    expect(prompts.join("\n")).toContain("Merge main into your branch");
    expect(await git(world().repo("api"), "show", "main:shared.txt")).toBe("main side\ntask side");
    const ran = (await notes()).filter((n) => n.includes("majhi will merge into main, as you asked"));
    expect(ran).toHaveLength(1);
    // The conflict that stopped the first merge, the owner's approval, then the merge that ran.
    expect(
      world()
        .h.majhi.services.store.permissions.audit("ACM-1")
        .map((r) => [r.kind, r.decision, r.by]),
    ).toEqual([
      ["merge", "failed", "owner"],
      ["ship", "allow", "owner"],
      ["merge", "done", "owner"],
    ]);

    // Another turn end finds nothing waiting: nothing runs again.
    const main = await tip(world().repo("api"), "main");
    await world().h.majhi.services.tasks.agentsIdle("ACM-1");
    expect(await tip(world().repo("api"), "main")).toBe(main);
  });

  it("still conflicting: forgets the ship and puts the task back in review with the reason", async () => {
    await conflicted();
    next = async () => undefined; // the lead ends its turn without resolving anything
    const main = await tip(world().repo("api"), "main");
    expect((await cmd("tasks.resolveShip", { id: "ACM-1", action: "merge", into: "main" })).status).toBe(200);

    await until(
      async () =>
        (await items()).some((i) => i.type === "review" && i.state === "pending" && i.why !== undefined),
      "the review card with the reason",
    );
    const task = await get();
    expect(task.status).toBe("review");
    expect(task.pendingShip).toBeUndefined();
    const card = (await items()).find((i) => i.type === "review" && i.state === "pending");
    expect(card?.type === "review" && card.why).toBe(
      "Did not merge into main: Still conflicts in shared.txt.",
    );
    expect(await tip(world().repo("api"), "main")).toBe(main);
  });

  it("a target that moved after the owner asked is not shipped onto", async () => {
    await conflicted();
    next = async () => {
      await resolve();
      // Someone commits to main while the lead works.
      await writeFile(join(world().repo("api"), "later.txt"), "later\n");
      await git(world().repo("api"), "add", "later.txt");
      await git(world().repo("api"), ...who, "commit", "-qm", "later");
    };
    expect((await cmd("tasks.resolveShip", { id: "ACM-1", action: "merge", into: "main" })).status).toBe(200);
    await until(
      async () =>
        (await items()).some((i) => i.type === "review" && i.state === "pending" && i.why !== undefined),
      "the review card with the reason",
    );
    const card = (await items()).find((i) => i.type === "review" && i.state === "pending");
    expect(card?.type === "review" && card.why).toBe(
      "Did not merge into main: main in acme-api moved since you asked. Look at it and ship again.",
    );
    expect(await git(world().repo("api"), "show", "main:shared.txt")).toBe("main side");
  });

  it("cancel: the lead finishes, and nothing ships", async () => {
    await conflicted();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    next = async () => {
      await gate;
      await resolve();
    };
    const main = await tip(world().repo("api"), "main");
    expect((await cmd("tasks.resolveShip", { id: "ACM-1", action: "merge", into: "main" })).status).toBe(200);
    const cancelled = await cmd("tasks.cancelShip", { id: "ACM-1" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.task.pendingShip).toBeUndefined();
    release();

    await world().h.majhi.services.runs.idle();
    await until(async () => (await get()).status === "review", "review");
    expect(await tip(world().repo("api"), "main")).toBe(main);
    expect(await notes()).toContain("majhi will not merge into main: you cancelled it.");
    expect(
      world()
        .h.majhi.services.store.permissions.audit("ACM-1")
        .map((r) => [r.kind, r.decision]),
    ).toEqual([
      ["merge", "failed"],
      ["ship", "allow"],
      ["ship", "deny"],
    ]);
  });
});

describe("the pending ship in the store", () => {
  it("survives a reopen, and is taken at most once", async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const file = join(t.dir, "majhi.db");
    const pending: PendingShip = {
      action: "mergePush",
      into: "develop",
      method: "squash",
      deleteAfter: true,
      lead: "acme-builder",
      requestedAt: "2026-10-01T09:00:00.000Z",
      by: "owner",
    };
    const first = new Store(file);
    first.tasks.insert({
      id: "ACM-7",
      title: "Fix",
      brief: "Fix",
      kind: "code",
      org: "acme",
      status: "running",
      folder: "/tasks/ACM-7",
      repos: [],
      team: ["acme-builder"],
      mode: "lead",
      overrides: {},
      links: [],
      attachments: [],
      createdAt: "2026-10-01T08:00:00.000Z",
      updatedAt: "2026-10-01T08:00:00.000Z",
    });
    first.tasks.setPendingShip("ACM-7", pending);
    first.close();

    const again = new Store(file);
    expect(again.tasks.get("ACM-7")?.pendingShip).toEqual(pending);
    expect(again.tasks.takePendingShip("ACM-7")).toEqual(pending);
    expect(again.tasks.takePendingShip("ACM-7")).toBeUndefined();
    expect(again.tasks.get("ACM-7")?.pendingShip).toBeUndefined();
    again.close();
  });
});
