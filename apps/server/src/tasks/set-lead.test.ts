import type { RoomItem, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

/** Acme with a lead, a builder and a reviewer, a task on the first two, and the captain "boss". */
async function acme() {
  w = await bossWorld({ real: false });
  const { h } = w;
  const must = async (name: string, body: unknown) => {
    const res = await h.cmd(name, body);
    if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  await must("accounts.create", { id: "codex-acme", tool: "codex", org: "acme", auth: "login" });
  await must("agents.create", {
    id: "acme-lead",
    frontmatter: { scope: "acme", role: "Lead", account: "codex-acme", perms: ["edit", "shell"] },
    instructions: "Plan and delegate.\n",
  });
  await must("agents.create", {
    id: "acme-other",
    frontmatter: { scope: "acme", role: "Builder", account: "claude-acme", perms: ["edit"] },
    instructions: "Build.\n",
  });
  const task = (await must("tasks.create", {
    text: "Add a health endpoint",
    repos: [{ project: "acme-api" }],
    team: ["acme-lead", "acme-builder"],
    start: false,
  })) as Task;
  const as = (agent: string | undefined, input: Record<string, unknown>) =>
    h.cmd(
      "tasks.setLead",
      { task: task.id, ...input },
      agent === undefined ? undefined : { actor: { kind: "agent", id: agent } },
    );
  const team = () => (h.majhi.services.store.tasks.get(task.id) as Task).team;
  const room = async () =>
    ((await h.cmd("room.items", { task: task.id, limit: 200 })).body.items as RoomItem[]).flatMap((i) =>
      i.type === "system" ? [i.text] : [],
    );
  return { h, task, as, team, room };
}

describe("tasks.setLead", () => {
  it("lets the owner hand the lead to a teammate: the old lead stays as a builder, the room gets the note", async () => {
    const t = await acme();
    expect(
      (await t.as(undefined, { agent: "acme-builder", reason: "the lead's account is at its limit" })).status,
    ).toBe(200);
    expect(t.team()).toEqual(["acme-builder", "acme-lead"]);
    const note = (await t.room()).find((l) => l.startsWith("Handover on"));
    expect(note).toContain("@acme-builder is the lead now, taking over from @acme-lead (the owner)");
    expect(note).toContain("Why: the lead's account is at its limit");
    expect(note).toContain("No plan was recorded");
    expect(note).toContain("@acme-lead stays on the team as a builder");
  });

  it("adds an agent that is not on the team, and lets the old lead leave", async () => {
    const t = await acme();
    expect((await t.as(undefined, { agent: "acme-other", keepOldLead: false })).status).toBe(200);
    expect(t.team()).toEqual(["acme-other", "acme-builder"]);
  });

  it("lets the captain and the current lead hand over, and refuses any other agent", async () => {
    const t = await acme();
    const other = await t.as("acme-other", { agent: "acme-other" });
    expect(other.status).toBe(409);
    expect(other.body.error).toContain("Only the owner, the captain or the lead, @acme-lead");
    expect(t.team()).toEqual(["acme-lead", "acme-builder"]);
    const builder = await t.as("acme-builder", { agent: "acme-builder" });
    expect(builder.status).toBe(409);

    expect((await t.as("boss", { agent: "acme-builder" })).status).toBe(200);
    expect(t.team()).toEqual(["acme-builder", "acme-lead"]);
    // The lead now is acme-builder: it may hand back.
    expect((await t.as("acme-builder", { agent: "acme-lead" })).status).toBe(200);
    expect(t.team()).toEqual(["acme-lead", "acme-builder"]);
  });

  it("refuses an agent of another workspace and the lead itself", async () => {
    const t = await acme();
    await t.h.cmd("orgs.create", { id: "globex", name: "Globex" });
    await t.h.cmd("agents.create", {
      id: "globex-lead",
      frontmatter: { scope: "globex", role: "Lead", account: "claude-acme", perms: [] },
      instructions: "Lead.\n",
    });
    const away = await t.as(undefined, { agent: "globex-lead" });
    expect(away.status).toBe(409);
    expect(away.body.error).toContain("cannot work in");
    expect((await t.as(undefined, { agent: "acme-lead" })).status).toBe(409);
    expect(t.team()).toEqual(["acme-lead", "acme-builder"]);
  });
});
