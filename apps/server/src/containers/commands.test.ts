import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeDocker } from "../testing/fakeDocker.ts";
import { taskWorld, type World } from "../testing/world.ts";

/** The containers commands, the image cards and the task hooks, over the whole server with a fake docker. */

let w: World;
let docker: FakeDocker;
beforeEach(async () => {
  docker = new FakeDocker();
  w = await taskWorld({ containerDocker: docker });
  expect(
    (await w.h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true }))
      .status,
  ).toBe(200);
});
afterEach(() => w?.cleanup());

const db = { task: "ACM-1", name: "db", image: "postgres:16-alpine", port: 5432 };
const volumes = [{ name: "pgdata", path: "/var/lib/postgresql/data" }];

describe("containers commands", () => {
  it("allows and removes images through their own commands, never through settings.set", async () => {
    const { h } = w;
    expect((await h.cmd("containers.images.allow", { image: "postgres:16-alpine" })).body.images).toEqual([
      "postgres:16-alpine",
    ]);
    // Again, and as name:latest: one entry.
    await h.cmd("containers.images.allow", { image: "postgres:16-alpine" });
    await h.cmd("containers.images.allow", { image: "redis" });
    expect((await h.cmd("containers.images.allow", { image: "redis:latest" })).body.images).toEqual([
      "postgres:16-alpine",
      "redis",
    ]);
    expect((await h.cmd("settings.get")).body.containers.images).toEqual(["postgres:16-alpine", "redis"]);
    expect((await h.cmd("settings.set", { containers: { images: ["evil"] } })).status).toBe(400);
    expect((await h.cmd("containers.images.remove", { image: "redis:latest" })).body.images).toEqual([
      "postgres:16-alpine",
    ]);
    expect((await h.cmd("containers.images.remove", { image: "redis" })).status).toBe(404);
  });

  it("allows an image for one workspace only, and the owner's list for every workspace stays", async () => {
    const { h } = w;
    const org = (await h.cmd("tasks.get", { id: "ACM-1" })).body.org as string;
    expect(org).toBeDefined();
    // Allowed in another workspace: this task's service is still refused.
    const other = await h.cmd("containers.images.allow", { image: db.image, org: "globex" });
    expect(other.body.images).toEqual([db.image]);
    expect((await h.cmd("containers.services.start", db)).status).toBe(400);
    expect((await h.cmd("settings.get")).body.containers.org_images).toEqual({ globex: [db.image] });
    // Allowed in this task's workspace: it starts. The global list is untouched.
    await h.cmd("containers.images.allow", { image: db.image, org, service: "db" });
    expect((await h.cmd("containers.services.start", db)).status).toBe(200);
    expect((await h.cmd("settings.get")).body.containers.images).toEqual([]);
    // An image allowed everywhere is not added to a workspace.
    await h.cmd("containers.images.allow", { image: "redis:7-alpine" });
    expect((await h.cmd("containers.images.allow", { image: "redis:7-alpine", org })).body.images).toEqual([
      db.image,
    ]);
    expect((await h.cmd("containers.images.remove", { image: db.image, org: "globex" })).status).toBe(200);
    expect((await h.cmd("containers.images.remove", { image: db.image, org: "globex" })).status).toBe(404);
    expect((await h.cmd("settings.set", { containers: { org_images: { x: ["evil"] } } })).status).toBe(400);
  });
});

describe("a task that ends", () => {
  async function running() {
    const { h } = w;
    await h.cmd("containers.images.allow", { image: db.image });
    expect((await h.cmd("containers.services.start", { ...db, volumes })).status).toBe(200);
    // The service and its holder.
    expect(docker.containers.size).toBe(2);
    expect(docker.networks.has("majhi-acm-1")).toBe(true);
    expect(docker.volumes.has("majhi-acm-1-data-pgdata")).toBe(true);
    docker.images.add("majhi-preview-acm-1");
    docker.builders.add("majhi-preview-acm-1");
  }

  it("stopping it removes the containers and the network but keeps the volumes", async () => {
    await running();
    expect((await w.h.cmd("tasks.stop", { id: "ACM-1" })).status).toBe(200);
    expect(docker.containers.size).toBe(0);
    expect(docker.networks.size).toBe(0);
    expect(docker.volumes.size).toBe(1);
    expect(docker.builders.size).toBe(1);
  });
});
