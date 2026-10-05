import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness } from "../testing/harness.ts";

let h: Harness;
afterEach(() => h?.cleanup());

const _as = { actor: { kind: "agent", id: "boss" }, reason: "for the test" };

describe("history and undo", () => {
  it("undoes one change, keeps the others, and marks it undone", async () => {
    h = await harness();
    await h.cmd("orgs.create", { id: "acme", name: "Acme" });
    await h.cmd("orgs.create", { id: "globex", name: "Globex" });
    const [globex] = (await h.cmd("history.list", { limit: 5 })).body;
    const undo = await h.cmd("history.undo", { commit: globex.commit.slice(0, 8) });
    expect(undo.status).toBe(200);
    const orgs = await h.cmd("orgs.list");
    expect(orgs.body.map((o: { id: string }) => o.id)).toEqual(["private", "acme"]);
    const list = (await h.cmd("history.list", { limit: 5 })).body;
    expect(list[0]).toMatchObject({ command: "history.undo", undone: false });
    expect(list[1]).toMatchObject({ command: "orgs.create", undone: true });
    expect((await h.cmd("history.undo", { commit: globex.commit })).status).toBe(409);
  });

  it("refuses when a later change touched the same lines, and leaves the files alone", async () => {
    h = await harness();
    await h.cmd("orgs.create", { id: "acme", name: "Acme" });
    const [first] = (await h.cmd("history.list", { limit: 1 })).body;
    await h.cmd("orgs.update", { id: "acme", name: "Acme Inc" });
    const before = (await h.cmd("orgs.list")).body;
    const undo = await h.cmd("history.undo", { commit: first.commit });
    expect(undo.status).toBe(409);
    expect((await h.cmd("orgs.list")).body).toEqual(before);
    expect(await h.log()).toHaveLength(4);
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
