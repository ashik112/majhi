import type { Task, TaskId } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { RoomService } from "../room/service.ts";
import { Store } from "../store/index.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

/** A task row for the store: the fields a room read looks at, the rest as any task. */
function task(id: string, org: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    title: `Title ${id}`,
    brief: "brief",
    kind: "code",
    org,
    status: "running",
    folder: `/tasks/${id}`,
    repos: [],
    team: ["boss"],
    mode: "lead",
    overrides: {},
    links: [],
    attachments: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  } as Task;
}

describe("one home: the captain's lines about a task stay in their workspace", () => {
  it("never shows a lane line about another workspace's task, in the task or in a thread", () => {
    const store = new Store(":memory:");
    const lane = { brief: "Captain lane", kind: "chat" as const };
    store.tasks.insert(task("ACM-1", "acme", lane));
    store.tasks.insert(task("GLX-1", "globex", lane));
    store.tasks.insert(task("ACM-2", "acme"));
    store.tasks.insert(task("GLX-2", "globex"));
    const lanes = new Map([
      ["ACM-1", "acme"],
      ["GLX-1", "globex"],
    ]);
    const room = new RoomService(store);
    room.useCaptain({
      lanesOf: (org) => [...lanes].filter(([, o]) => o === org).map(([chat]) => chat),
      orgOfLane: (chat) => lanes.get(chat),
    });
    const say = (laneId: string, id: string, text: string) =>
      room.post(laneId as TaskId, id, { type: "agent", agent: "boss", text });

    // The acme captain acts on an acme task and tries a globex one: the second subject is refused.
    room.setSubject("ACM-1", "ACM-2" as TaskId);
    say("ACM-1", "a1", "Added the connection to ACM-2");
    room.setSubject("ACM-1", "GLX-2" as TaskId);
    expect(room.subjectOf("ACM-1")).toBe("ACM-2");
    // A line forged to point at a globex task is still read only from globex's own lanes.
    store.room.upsert("ACM-1" as TaskId, "forged", {
      type: "agent",
      agent: "boss",
      text: "secret of acme",
      about: "GLX-2" as TaskId,
    });
    room.setSubject("ACM-1", undefined);
    say("ACM-1", "a2", "Plain thread talk in acme");
    say("GLX-1", "g1", "Plain thread talk in globex");

    const texts = (t: Task) => room.snapshot(t).items.flatMap((i) => (i.type === "agent" ? [i.text] : []));
    const get = (id: string) => store.tasks.get(id) as Task;
    expect(texts(get("ACM-2"))).toEqual(["Added the connection to ACM-2"]);
    expect(texts(get("GLX-2"))).toEqual([]);
    expect(texts(get("ACM-1"))).toEqual(["Plain thread talk in acme"]);
    expect(texts(get("GLX-1"))).toEqual(["Plain thread talk in globex"]);

    // A turn that acts on two tasks tags only what follows the first call; what follows the second is about neither.
    store.tasks.insert(task("ACM-3", "acme"));
    room.setSubject("ACM-1", "ACM-2" as TaskId);
    say("ACM-1", "m1", "Told the lead of ACM-2");
    room.setSubject("ACM-1", "ACM-3" as TaskId);
    say("ACM-1", "m2", "Summary of both");
    room.setSubject("ACM-1", undefined);
    expect(texts(get("ACM-2"))).toEqual(["Added the connection to ACM-2", "Told the lead of ACM-2"]);
    expect(texts(get("ACM-3"))).toEqual([]);
    expect(texts(get("ACM-1"))).toContain("Summary of both");
  });
});

describe("one home: the captain never joins a task's team", () => {
  let w: BossWorld;
  afterEach(() => w?.cleanup());

  it("keeps the captain off the team when a worker hands work or mentions it", async () => {
    w = await bossWorld({ real: false });
    await w.addRepo("api");
    const made = await w.h.cmd("tasks.create", {
      text: "fix api",
      start: false,
      repos: [{ project: "acme-api" }],
    });
    const id = made.body.id as string;
    const { coordinator, tasks } = w.h.majhi.services;
    // The handoff tool: refused or turned into a wake of the lane, never a team change.
    await coordinator
      .mention({ task: id, agent: made.body.team[0] as string }, "boss", "I need an SSH connection")
      .catch(() => undefined);
    // An agent's add of the captain is refused whatever path it comes by.
    await expect(tasks.addToTeam(id, "boss", { by: made.body.team[0] as string })).rejects.toThrow();
    const after = await w.h.cmd("tasks.get", { id });
    expect(after.body.team).not.toContain("boss");
  });
});
