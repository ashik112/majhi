import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

describe("orgs.rename", () => {
  it("updates accounts, projects, agents and tasks in one config commit, and keeps task keys", async () => {
    w = await taskWorld();
    const { h } = w;
    const task = (await h.cmd("tasks.create", { text: "fix api", start: false })).body;
    expect(task.id).toBe("ACM-1");
    const before = (await h.log()).length;

    const res = await h.cmd("orgs.rename", { id: "acme", newId: "acme-corp" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "acme-corp",
      name: "Acme",
      key: "ACM",
      accountCount: 1,
      agentCount: 1,
    });
    expect((await h.log()).length).toBe(before + 1);

    const yaml = await readFile(join(h.env.majhiHome, "majhi.yaml"), "utf8");
    expect(yaml).not.toMatch(/^\s*acme:/m);
    expect(yaml).toMatch(/org: acme-corp/);
    const orgs = (await h.cmd("orgs.list")).body as { id: string }[];
    expect(orgs.map((o) => o.id)).toContain("acme-corp");
    expect(orgs.map((o) => o.id)).not.toContain("acme");
    const agent = await readFile(join(h.env.majhiHome, "agents", "acme-builder.md"), "utf8");
    expect(agent).toContain("scope: acme-corp");
    expect((await h.cmd("accounts.list")).body[0].org).toBe("acme-corp");
    expect((await h.cmd("projects.list")).body[0].org).toBe("acme-corp");
    const got = (await h.cmd("tasks.get", { id: "ACM-1" })).body;
    expect(got.org).toBe("acme-corp");
    // New tasks still use the org's key.
    expect((await h.cmd("tasks.create", { text: "fix api again", start: false })).body.id).toBe("ACM-2");
  });

  it("refuses private, reserved, taken and missing ids", async () => {
    w = await taskWorld();
    const { h } = w;
    expect((await h.cmd("orgs.rename", { id: "private", newId: "mine" })).status).toBe(409);
    expect((await h.cmd("orgs.rename", { id: "acme", newId: "root" })).status).toBe(400);
    expect((await h.cmd("orgs.rename", { id: "acme", newId: "private" })).status).toBe(400);
    expect((await h.cmd("orgs.rename", { id: "nope", newId: "other" })).status).toBe(404);
    await h.cmd("orgs.create", { id: "globex", name: "Globex" });
    expect((await h.cmd("orgs.rename", { id: "acme", newId: "globex" })).status).toBe(409);
  });
});
