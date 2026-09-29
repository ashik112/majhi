import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness } from "../testing/harness.ts";

let h: Harness;
afterEach(() => h?.cleanup());

const as = { actor: { kind: "agent", id: "boss" }, reason: "for the test" };

describe("history and undo", () => {
  it("lists changes newest first with actor, command and reason from the trailers", async () => {
    h = await harness();
    await h.cmd("orgs.create", { id: "acme", name: "Acme" }, as);
    await h.cmd("orgs.update", { id: "acme", name: "Acme Inc" });
    const list = await h.cmd("history.list", { limit: 10 });
    expect(list.status).toBe(200);
    expect(list.body.map((e: { command: string; actor: string }) => [e.command, e.actor])).toEqual([
      ["orgs.update", "owner"],
      ["orgs.create", "boss"],
      ["workspaces.set", "owner"],
    ]);
    expect(list.body[1]).toMatchObject({ reason: "for the test", undone: false });
    expect(list.body[1].commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("shows hand edits as manual", async () => {
    h = await harness();
    await h.cmd("orgs.create", { id: "acme", name: "Acme" });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(h.majhi.services.config.file, "\n# a comment\n");
    await h.cmd("orgs.create", { id: "globex", name: "Globex" });
    const list = await h.cmd("history.list", { limit: 10 });
    expect(list.body.map((e: { actor: string }) => e.actor)).toEqual(["owner", "manual", "owner", "owner"]);
  });

  it("undoes one change, keeps the others, and marks it undone", async () => {
    h = await harness();
    await h.cmd("orgs.create", { id: "acme", name: "Acme" });
    await h.cmd("orgs.create", { id: "globex", name: "Globex" });
    const [globex] = (await h.cmd("history.list", { limit: 5 })).body;
    const undo = await h.cmd("history.undo", { commit: globex.commit.slice(0, 8) });
    expect(undo.status).toBe(200);
    expect(undo.body.summary).toBe("added org globex");
    const orgs = await h.cmd("orgs.list");
    expect(orgs.body.map((o: { id: string }) => o.id)).toEqual(["private", "acme"]);
    const list = (await h.cmd("history.list", { limit: 5 })).body;
    expect(list[0]).toMatchObject({ command: "history.undo", undone: false });
    expect(list[1]).toMatchObject({ command: "orgs.create", undone: true });
    expect((await h.cmd("history.undo", { commit: globex.commit })).status).toBe(409);
  });

  it("can redo by undoing the undo", async () => {
    h = await harness();
    await h.cmd("orgs.create", { id: "acme", name: "Acme" });
    const [create] = (await h.cmd("history.list", { limit: 1 })).body;
    const undo = await h.cmd("history.undo", { commit: create.commit });
    await h.cmd("history.undo", { commit: undo.body.commit });
    expect((await h.cmd("orgs.list")).body).toHaveLength(2);
    const list = (await h.cmd("history.list", { limit: 5 })).body;
    expect(list.find((e: { commit: string }) => e.commit === create.commit).undone).toBe(false);
  });

  it("refuses when a later change touched the same lines, and leaves the files alone", async () => {
    h = await harness();
    await h.cmd("orgs.create", { id: "acme", name: "Acme" });
    const [first] = (await h.cmd("history.list", { limit: 1 })).body;
    await h.cmd("orgs.update", { id: "acme", name: "Acme Inc" });
    const before = (await h.cmd("orgs.list")).body;
    const undo = await h.cmd("history.undo", { commit: first.commit });
    expect(undo.status).toBe(409);
    expect(undo.body.error).toContain("later change touched the same lines");
    expect((await h.cmd("orgs.list")).body).toEqual(before);
    expect(await h.log()).toHaveLength(4);
  });

  it("refuses the start of the history and unknown commits", async () => {
    h = await harness();
    await h.cmd("orgs.create", { id: "acme", name: "Acme" });
    const start = (await h.log("%H")).at(-1);
    expect((await h.cmd("history.undo", { commit: start })).status).toBe(400);
    expect((await h.cmd("history.undo", { commit: "deadbeef" })).status).toBe(404);
    expect((await h.cmd("history.undo", { commit: "xyz" })).status).toBe(400);
  });

  it("does not undo the owner's hand edits along with a command", async () => {
    h = await harness();
    await h.cmd("orgs.create", { id: "acme", name: "Acme" });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(h.majhi.services.config.file, "# my note\n");
    await h.cmd("orgs.create", { id: "globex", name: "Globex" });
    const [globex] = (await h.cmd("history.list", { limit: 1 })).body;
    await h.cmd("history.undo", { commit: globex.commit });
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(h.majhi.services.config.file, "utf8")).toContain("# my note");
  });
});
