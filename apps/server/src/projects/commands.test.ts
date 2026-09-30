import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

describe("projects", () => {
  it("registers a repo with an org and aliases, and commits it with the actor", async () => {
    w = await taskWorld();
    const list = await w.h.cmd("projects.list");
    expect(list.body).toEqual([
      { id: "acme-api", org: "acme", path: w.repo("api"), aliases: ["api"], base: "main", exists: true },
    ]);
    expect(await readFile(join(w.h.env.majhiHome, "majhi.yaml"), "utf8")).toContain("acme-api:");
    expect((await w.h.log())[0]).toBe("projects.register: registered project acme-api (acme)");
  });

  it("refuses paths outside the roots, non-repos, missing orgs and duplicates", async () => {
    w = await taskWorld();
    const c = (body: Record<string, unknown>) =>
      w.h.cmd("projects.register", { org: "acme", aliases: [], ...body });
    const outside = await c({ id: "out", path: "/tmp" });
    expect(outside.status).toBe(400);
    expect(outside.body.error).toMatch(/is not inside a workspace root/);

    await mkdir(w.repo("plain"), { recursive: true });
    const plain = await c({ id: "plain", path: "~/Work/plain" });
    expect(plain.status).toBe(400);
    expect(plain.body.error).toMatch(/is not a git repo the server can see/);

    await w.addRepo("web");
    expect((await c({ id: "web", path: "~/Work/web", org: "nope" })).body.error).toMatch(
      /Org "nope" does not exist/,
    );
    expect((await c({ id: "acme-api", path: "~/Work/web" })).status).toBe(409);
    const samePath = await c({ id: "again", path: "~/Work/api" });
    expect(samePath.status).toBe(409);
    expect(samePath.body.error).toMatch(/already registered as "acme-api"/);
  });
});
