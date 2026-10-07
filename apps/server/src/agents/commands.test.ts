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
