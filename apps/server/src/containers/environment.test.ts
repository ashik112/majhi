import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContainersSettings, ContainersSettingsSchema, type Task } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcessManager } from "../processes/manager.ts";
import { FakeDocker } from "../testing/fakeDocker.ts";
import { until } from "../testing/until.ts";
import { ContainerService } from "./service.ts";

/**
 * The environment belongs to the project (docs/briefs/workflow-reset.md, step 2): what the owner sees
 * when two workspaces and two tasks of one project share a machine, over the container service and a fake docker.
 */

let dir: string;
let docker: FakeDocker;
let processes: ProcessManager;
let service: ContainerService;
let settings: ContainersSettings;
let said: { task: string; text: string }[];
let open: string[];

const TASKS: Record<string, { org: string; project: string }> = {
  "ACM-1": { org: "acme", project: "acme-api" },
  "ACM-2": { org: "acme", project: "acme-api" },
  "GLX-1": { org: "globex", project: "globex-web" },
};

const task = (id: string): Task => {
  const found = TASKS[id];
  if (found === undefined) throw new Error(`no ${id}`);
  return {
    id,
    folder: join(dir, "tasks", id),
    org: found.org,
    team: ["builder"],
    repos: [{ project: found.project, worktree: join(dir, "tasks", id, "api") }],
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Task;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "majhi-env-"));
  for (const id of Object.keys(TASKS)) {
    await mkdir(join(dir, "tasks", id, "api"), { recursive: true });
    await writeFile(join(dir, "tasks", id, "api", "Dockerfile"), "FROM scratch\n");
  }
  docker = new FakeDocker();
  open = Object.keys(TASKS);
  said = [];
  settings = ContainersSettingsSchema.parse({ images: ["postgres:16-alpine"] });
  processes = new ProcessManager({
    spawner: async () => {
      throw new Error("A container is not run by the runner spawner.");
    },
    launch: async () => {
      throw new Error("A container has no launch settings.");
    },
    throttleMs: 5,
  });
  service = new ContainerService({
    docker,
    processes,
    task: (id) => (TASKS[id] === undefined ? undefined : task(id)),
    openTasks: () => open,
    queueWaitMs: async () => 30 * 60_000,
    allTasks: () => Object.keys(TASKS),
    notify: (t, text) => said.push({ task: t, text }),
    settings: async () => settings,
    runnerNetwork: "majhi-runners",
    runnerImage: "majhi-runner:dev",
    guardServer: () => ({ host: "majhi-server", port: 7070 }),
    paths: {
      majhiHome: join(dir, "home", ".majhi"),
      hostHome: join(dir, "home"),
      protectedPaths: [join(dir, "keys", "secrets.key")],
    },
    portWaitMs: 2_000,
  });
});

afterEach(async () => {
  await processes.stopAll();
  await rm(dir, { recursive: true, force: true });
});

const db = {
  name: "db",
  image: "postgres:16-alpine",
  port: 5432,
  env: { POSTGRES_DB: "dev" },
  volumes: [{ name: "pgdata", path: "/var/lib/postgresql/data" }],
};

describe("two workspaces", () => {
  it("share no builder, network, container, volume or image", async () => {
    for (const id of ["ACM-1", "GLX-1"]) {
      await service.serviceStart(id, "builder", db);
      const info = await service.previewBuild(id, "builder", { dockerfile: "Dockerfile" });
      await until(() => processes.get(id, info.id)?.status !== "running");
    }
    expect([...docker.builders].sort()).toEqual(["majhi-build-acme", "majhi-build-globex"]);
    expect([...docker.networks.keys()].sort()).toEqual(["majhi-acme-api", "majhi-globex-web"]);
    expect([...docker.volumes.keys()].sort()).toEqual([
      "majhi-acme-api-data-pgdata",
      "majhi-globex-web-data-pgdata",
    ]);
    expect([...docker.images].sort()).toEqual(["majhi-acme-api-preview", "majhi-globex-web-preview"]);
    // Every object says whose it is.
    expect(docker.volumes.get("majhi-acme-api-data-pgdata")?.labels).toEqual({
      "majhi.container": "volume",
      "majhi.org": "acme",
      "majhi.project": "acme-api",
    });
    for (const c of docker.containers.values()) {
      const expected = c.name.includes("acme-api") ? "acme" : "globex";
      expect(c.labels["majhi.org"], c.name).toBe(expected);
    }
    // A volume that carries another workspace's labels is never taken over.
    docker.volumes.set("majhi-acme-api-data-shared", {
      labels: { "majhi.container": "volume", "majhi.org": "globex", "majhi.project": "globex-web" },
      options: {},
    });
    await expect(
      service.serviceStart("ACM-1", "builder", {
        ...db,
        name: "cache",
        volumes: [{ name: "shared", path: "/data" }],
      }),
    ).rejects.toThrow("not one majhi made");
  });
});

describe("a volume with no source", () => {
  it("is the only kind `docker compose down -v` removes: the project's shared volume stays", async () => {
    const shop = join(dir, "tasks", "ACM-1", "api");
    await writeFile(
      join(shop, "compose.yaml"),
      "services:\n  db:\n    image: postgres:16-alpine\n    volumes: ['pgdata:/var/lib/postgresql/data']\n  cache:\n    image: postgres:16-alpine\n    volumes: [{type: volume, target: /scratch}]\nvolumes:\n  pgdata: {}\n",
    );
    const call = (...argv: string[]) =>
      service.taskDocker("ACM-1", { argv, cwd: shop }, { ask: async () => "pending" });
    const up = await call("compose", "up", "-d");
    expect(up.stderr).toBe("");
    expect([...docker.volumes.keys()].sort()).toEqual([
      "majhi-acme-api-data-anon-6591aa6c4f",
      "majhi-acme-api-data-pgdata",
    ]);

    const down = await call("compose", "down", "-v");

    expect(down.code).toBe(0);
    expect(down.stderr).toBe(
      "docker: [volume_shared] pgdata belongs to the project environment and stays. Ask the owner or the captain to remove it.\n",
    );
    expect([...docker.volumes.keys()]).toEqual(["majhi-acme-api-data-pgdata"]);
  });
});
