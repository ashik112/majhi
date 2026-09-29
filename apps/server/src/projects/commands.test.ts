import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../testing/fixtures.ts";
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

  it("resolves the base: project, then org, then the repo's default branch", async () => {
    w = await taskWorld();
    // Default branch of the repo: origin/HEAD is main.
    expect((await w.h.cmd("projects.list")).body[0].base).toBe("main");
    // Without origin/HEAD it falls back to the checked out branch.
    await git(w.repo("api"), "checkout", "--quiet", "develop");
    await git(w.repo("api"), "remote", "set-head", "origin", "--delete");
    await new Promise((r) => setTimeout(r, 0));
    const fresh = w.h.restart();
    expect((await fresh.cmd("projects.list")).body[0].base).toBe("develop");
    // The org's base beats the repo's.
    await mkdir(w.repo("web"), { recursive: true });
    await git(w.repo("web"), "init", "--quiet", "--initial-branch=trunk");
    await fresh.cmd("orgs.create", { id: "beta", name: "Beta", base: "release" });
    await fresh.cmd("projects.register", {
      id: "beta-web",
      org: "beta",
      path: "~/Work/web",
      aliases: ["web"],
    });
    const projects = (await fresh.cmd("projects.list")).body;
    expect(projects.find((p: { id: string }) => p.id === "beta-web").base).toBe("release");
    // The project's own base beats the org's.
    await fresh.cmd("projects.update", { id: "beta-web", org: "beta", aliases: ["web"], base: "hotfix" });
    expect(
      (await fresh.cmd("projects.list")).body.find((p: { id: string }) => p.id === "beta-web").base,
    ).toBe("hotfix");
  });

  it("marks repos scan results as registered", async () => {
    w = await taskWorld();
    const scan = await w.h.cmd("repos.scan", { refresh: true });
    const repo = scan.body.roots[0].repos.find((r: { name: string }) => r.name === "api");
    expect(repo.registered).toBe(true);
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

  it("keeps aliases unique across projects and never equal to another project's id", async () => {
    w = await taskWorld();
    await w.addRepo("web");
    const c = (body: Record<string, unknown>) => w.h.cmd("projects.register", { org: "acme", ...body });
    const dup = await c({ id: "acme-web", path: "~/Work/web", aliases: ["api"] });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('Alias "api" is already used by project "acme-api".');
    const asId = await c({ id: "acme-web", path: "~/Work/web", aliases: ["acme-api"] });
    expect(asId.body.error).toBe('Alias "acme-api" is the id of another project.');
    const idAsAlias = await c({ id: "api", path: "~/Work/web", aliases: [] });
    expect(idAsAlias.body.error).toBe('"api" is already an alias of project "acme-api".');
    // Aliases are lowercased.
    const ok = await c({ id: "acme-web", path: "~/Work/web", aliases: ["Web", "WEB", "front"] });
    expect(ok.body.aliases).toEqual(["web", "front"]);
  });

  it("updates org, aliases and base, and removes a project without touching the repo", async () => {
    w = await taskWorld();
    const upd = await w.h.cmd("projects.update", {
      id: "acme-api",
      org: "acme",
      aliases: ["backend"],
      base: "develop",
    });
    expect(upd.body).toMatchObject({ aliases: ["backend"], base: "develop" });
    expect((await w.h.cmd("projects.update", { id: "nope", org: "acme", aliases: [] })).status).toBe(404);
    expect((await w.h.cmd("projects.remove", { id: "acme-api" })).body).toEqual({ removed: "acme-api" });
    expect((await w.h.cmd("projects.list")).body).toEqual([]);
    expect(await git(w.repo("api"), "rev-parse", "--is-inside-work-tree")).toBe("true");
    expect((await w.h.cmd("projects.remove", { id: "acme-api" })).status).toBe(404);
  });

  it("shows a project whose repo disappeared as not existing", async () => {
    w = await taskWorld();
    const { rm } = await import("node:fs/promises");
    await rm(w.repo("api"), { recursive: true });
    expect((await w.h.cmd("projects.list")).body[0]).toMatchObject({ id: "acme-api", exists: false });
  });
});
