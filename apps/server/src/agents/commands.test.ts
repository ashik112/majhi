import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness } from "../testing/harness.ts";

let h: Harness;
afterEach(() => h?.cleanup());

const draft = (over: Record<string, unknown> = {}) => ({
  frontmatter: { scope: "acme", role: "Builder", account: "claude-acme", ...over },
  instructions: "Build things.\n",
});

async function setup() {
  h = await harness();
  await h.cmd("orgs.create", { id: "acme", name: "Acme" });
  await h.cmd("accounts.create", { id: "claude-acme", tool: "claude", org: "acme", auth: "login" });
  await h.cmd("accounts.models", { id: "claude-acme" });
}

const agentsDir = () => join(h.env.majhiHome, "agents");

describe("agent commands", () => {
  it("creates, updates, duplicates and removes agent files, one commit each", async () => {
    await setup();
    const created = await h.cmd(
      "agents.create",
      { id: "builder", ...draft({ model: "sonnet" }) },
      { reason: "new builder" },
    );
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      status: "ok",
      file: "builder.md",
      warnings: [],
      isBoss: false,
      agent: { frontmatter: { id: "builder", model: "sonnet" }, instructions: "Build things.\n" },
    });
    expect(await readFile(join(agentsDir(), "builder.md"), "utf8")).toContain("id: builder\nscope: acme");
    expect((await h.log())[0]).toBe("agents.create: new builder");

    const updated = await h.cmd("agents.update", {
      id: "builder",
      ...draft({ model: "opus", effort: "high" }),
    });
    expect(updated.body.agent.frontmatter).toMatchObject({ model: "opus", effort: "high" });
    expect((await h.log())[0]).toBe("agents.update: updated agent builder");

    const copy = await h.cmd("agents.duplicate", { id: "builder", newId: "builder-2" });
    expect(copy.body.agent.frontmatter.id).toBe("builder-2");
    expect(copy.body.agent.instructions).toBe("Build things.\n");
    expect((await h.cmd("agents.list")).body.map((e: { file: string }) => e.file)).toEqual([
      "builder-2.md",
      "builder.md",
    ]);

    const removed = await h.cmd("agents.remove", { id: "builder-2" });
    expect(removed.body).toEqual({ removed: "builder-2" });
    expect((await h.cmd("agents.list")).body).toHaveLength(1);
    expect((await h.log())[0]).toBe("agents.remove: removed agent builder-2");
  });

  it("refuses duplicates of ids, and updates or removals of unknown agents", async () => {
    await setup();
    await h.cmd("agents.create", { id: "builder", ...draft() });
    expect((await h.cmd("agents.create", { id: "builder", ...draft() })).status).toBe(409);
    expect((await h.cmd("agents.duplicate", { id: "builder", newId: "builder" })).status).toBe(409);
    expect((await h.cmd("agents.update", { id: "nope", ...draft() })).status).toBe(404);
    expect((await h.cmd("agents.remove", { id: "nope" })).status).toBe(404);
  });
});

describe("boss", () => {
  it("only a valid root agent can be captain, and the captain cannot be removed", async () => {
    await setup();
    await h.cmd("agents.create", { id: "builder", ...draft() });
    await h.cmd("agents.create", { id: "chief", ...draft({ scope: "root", role: "Root" }) });
    await mkdir(agentsDir(), { recursive: true });
    await writeFile(join(agentsDir(), "broken.md"), "---\nid: broken\n---\n");

    expect((await h.cmd("boss.set", { id: "nope" })).status).toBe(404);
    expect((await h.cmd("boss.set", { id: "builder" })).status).toBe(409);
    expect((await h.cmd("boss.set", { id: "broken" })).status).toBe(409);

    expect((await h.cmd("boss.set", { id: "chief" })).body).toEqual({ boss: "chief" });
    expect(await readFile(join(h.env.majhiHome, "majhi.yaml"), "utf8")).toContain("boss: chief");
    expect((await h.log())[0]).toBe("boss.set: made chief the captain");
    const chief = (await h.cmd("agents.list")).body.find((e: { file: string }) => e.file === "chief.md");
    expect(chief.isBoss).toBe(true);

    const removal = await h.cmd("agents.remove", { id: "chief" });
    expect(removal.status).toBe(409);
    await rm(join(agentsDir(), "broken.md"));
  });
});
