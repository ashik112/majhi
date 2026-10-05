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

  it("starts a service only from an allowed image, and stops it", async () => {
    const { h } = w;
    const refused = await h.cmd("containers.services.start", db);
    expect(refused.status).toBe(400);
    await h.cmd("containers.images.allow", { image: db.image });
    const started = await h.cmd("containers.services.start", { ...db, volumes });
    expect(started.status).toBe(200);
    expect(started.body.container).toMatchObject({
      name: "db",
      kind: "service",
      status: "running",
      url: "db:5432",
    });
    const listed = await h.cmd("containers.list", { task: "ACM-1" });
    expect(listed.body.containers).toHaveLength(1);
    // The container is a process of the task too: the Processes card shows it.
    const processes = (await h.cmd("tasks.get", { id: "ACM-1" })).body;
    expect(processes.id).toBe("ACM-1");
    expect(h.majhi.services.processes.list("ACM-1")[0]?.container).toMatchObject({
      kind: "service",
      name: "db",
    });
    const stopped = await h.cmd("containers.stop", { task: "ACM-1", name: "db" });
    expect(stopped.body.container.status).toBe("stopped");
  });
});

describe("a task that ends", () => {
  async function running() {
    const { h } = w;
    await h.cmd("containers.images.allow", { image: db.image });
    expect((await h.cmd("containers.services.start", { ...db, volumes })).status).toBe(200);
    expect(docker.containers.size).toBe(1);
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

  it("closing it removes the volumes, the builder and the preview image too", async () => {
    await running();
    expect((await w.h.cmd("tasks.close", { id: "ACM-1" })).status).toBe(200);
    expect(docker.containers.size).toBe(0);
    expect(docker.networks.size).toBe(0);
    expect(docker.volumes.size).toBe(0);
    expect(docker.builders.size).toBe(0);
    expect(docker.images.size).toBe(0);
  });
});
