import { afterEach, describe, expect, it, vi } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

const draft = (scope: string, over: Record<string, unknown> = {}) => ({
  frontmatter: { scope, role: "Builder", account: "claude-acme", ...over },
  instructions: "Work.\n",
});

describe("agents.rename", () => {
  it("moves the file and every reference in one config commit, and refuses a working agent", async () => {
    w = await taskWorld();
    const { h } = w;
    await h.cmd("agents.create", { id: "acme-lead", ...draft("acme", { fallback: "acme-builder" }) });
    await h.cmd("agents.create", { id: "boss-a", ...draft("root", { role: "Root" }) });
    expect((await h.cmd("boss.set", { id: "boss-a" })).status).toBe(200);
    expect((await h.cmd("decisions.set", { acp_agent: "boss-a" })).status).toBe(200);
    expect((await h.cmd("settings.set", { memory: { housekeeper: "boss-a" } })).status).toBe(200);
    const task = (
      await h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: false })
    ).body;
    expect(task.team).toEqual(["acme-builder"]);

    // A working agent is refused.
    const working = vi.spyOn(h.majhi.services.runs, "isWorking").mockReturnValue(true);
    const refused = await h.cmd("agents.rename", { id: "acme-builder", newId: "acme-dev" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("working");
    working.mockRestore();

    const before = (await h.log()).length;
    const res = await h.cmd("agents.rename", { id: "acme-builder", newId: "acme-dev" });
    expect(res.status).toBe(200);
    expect(res.body.agent.frontmatter.id).toBe("acme-dev");
    expect((await h.log()).length).toBe(before + 1);
    const list = (await h.cmd("agents.list")).body as {
      file: string;
      agent?: { frontmatter: { fallback?: string } };
    }[];
    expect(list.map((e) => e.file).sort()).toEqual(["acme-dev.md", "acme-lead.md", "boss-a.md"]);
    expect(list.find((e) => e.file === "acme-lead.md")?.agent?.frontmatter.fallback).toBe("acme-dev");
    expect((await h.cmd("tasks.get", { id: task.id })).body.team).toEqual(["acme-dev"]);

    // The boss and the decisions agent follow a rename too.
    expect((await h.cmd("agents.rename", { id: "boss-a", newId: "chief" })).status).toBe(200);
    expect((await h.majhi.services.config.sections()).boss).toBe("chief");
    expect((await h.cmd("decisions.status")).body.settings.acp_agent).toBe("chief");
    expect((await h.cmd("settings.get")).body.memory.housekeeper).toBe("chief");

    // Taken and missing ids are refused.
    expect((await h.cmd("agents.rename", { id: "acme-dev", newId: "acme-lead" })).status).toBe(409);
    expect((await h.cmd("agents.rename", { id: "nobody", newId: "somebody" })).status).toBe(404);
  });
});
