import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

describe("projects", () => {
  it("refuses paths outside the roots, non-repos, missing orgs and duplicates", async () => {
    w = await taskWorld();
    const c = (body: Record<string, unknown>) =>
      w.h.cmd("projects.register", { org: "acme", aliases: [], ...body });
    const outside = await c({ id: "out", path: "/tmp" });
    expect(outside.status).toBe(400);

    await mkdir(w.repo("plain"), { recursive: true });
    const plain = await c({ id: "plain", path: "~/Work/plain" });
    expect(plain.status).toBe(400);

    await w.addRepo("web");
    expect((await c({ id: "web", path: "~/Work/web", org: "nope" })).status).toBe(400);
    expect((await c({ id: "acme-api", path: "~/Work/web" })).status).toBe(409);
    const samePath = await c({ id: "again", path: "~/Work/api" });
    expect(samePath.status).toBe(409);
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

  it("refuses two MR remotes, a link to nothing, to itself, and a loop", async () => {
    await withWeb();
    const two = await update({ remotes: { a: { mr: true }, b: { mr: true } } });
    expect(two.status).toBe(400);
    expect((await update({ links: [{ to: "nope", type: "depends-on" }] })).status).toBeGreaterThanOrEqual(400);
    expect((await update({ links: [{ to: "acme-web", type: "depends-on" }] })).status).toBeGreaterThanOrEqual(
      400,
    );
    expect((await update({ links: [{ to: "acme-api", type: "depends-on" }] })).status).toBe(200);
    const loop = await w.h.cmd("projects.update", {
      id: "acme-api",
      org: "acme",
      aliases: ["api"],
      links: [{ to: "acme-web", type: "depends-on" }],
    });
    expect(loop.status).toBe(409);
  });
});
