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
      {
        id: "acme-api",
        org: "acme",
        path: w.repo("api"),
        aliases: ["api"],
        base: "main",
        exists: true,
        remotes: {},
        links: [],
      },
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

describe("project remotes and links", () => {
  const update = (extra: Record<string, unknown>) =>
    w.h.cmd("projects.update", { id: "acme-web", org: "acme", aliases: ["web"], ...extra });

  async function withWeb() {
    w = await taskWorld();
    await w.addRepo("web");
    expect(
      (
        await w.h.cmd("projects.register", {
          id: "acme-web",
          org: "acme",
          path: "~/Work/web",
          aliases: ["web"],
        })
      ).status,
    ).toBe(200);
  }

  it("stores remotes and links, names the MR remote, and keeps them when only aliases change", async () => {
    await withWeb();
    const set = await update({
      remotes: { origin: { host: "gitlab", ssh: "gitlab-acme" }, fork: { mr: true } },
      links: [{ to: "acme-api", type: "depends-on" }],
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({
      remotes: { origin: { host: "gitlab", ssh: "gitlab-acme" }, fork: { mr: true } },
      links: [{ to: "acme-api", type: "depends-on" }],
      mrRemote: "fork",
    });
    // A call that names neither leaves them alone.
    const again = await update({ aliases: ["web", "frontend"] });
    expect(again.body.links).toHaveLength(1);
    expect(again.body.remotes.fork).toEqual({ mr: true });
    // null removes them.
    const cleared = await update({ remotes: null, links: null });
    expect(cleared.body).toMatchObject({ remotes: {}, links: [] });
    expect(cleared.body.mrRemote).toBeUndefined();
  });

  it("refuses two MR remotes, a link to nothing, to itself, and a loop", async () => {
    await withWeb();
    const two = await update({ remotes: { a: { mr: true }, b: { mr: true } } });
    expect(two.status).toBe(400);
    expect(two.body.error).toMatch(/Only one remote can take MRs/);
    expect((await update({ links: [{ to: "nope", type: "depends-on" }] })).body.error).toMatch(
      /Project "nope" does not exist/,
    );
    expect((await update({ links: [{ to: "acme-web", type: "depends-on" }] })).body.error).toMatch(
      /cannot depend on itself/,
    );
    expect((await update({ links: [{ to: "acme-api", type: "depends-on" }] })).status).toBe(200);
    const loop = await w.h.cmd("projects.update", {
      id: "acme-api",
      org: "acme",
      aliases: ["api"],
      links: [{ to: "acme-web", type: "depends-on" }],
    });
    expect(loop.status).toBe(409);
    expect(loop.body.error).toContain("acme-api -> acme-web -> acme-api");
  });
});
