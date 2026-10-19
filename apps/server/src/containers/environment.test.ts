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
  });

  it("never reuse a volume that another workspace made", async () => {
    docker.volumes.set("majhi-acme-api-data-pgdata", {
      labels: { "majhi.container": "volume", "majhi.org": "globex", "majhi.project": "globex-web" },
      options: {},
    });
    await expect(service.serviceStart("ACM-1", "builder", db)).rejects.toThrow(/not one majhi made/);
  });
});

describe("one environment per project", () => {
  it("goes to exactly one task, and to the next in line when it is released", async () => {
    await service.serviceStart("ACM-1", "builder", db);
    expect(service.taskNetworks("ACM-1")).toEqual(["majhi-acme-api"]);

    const second = service.serviceStart("ACM-2", "builder", {
      ...db,
      name: "cache",
      image: "postgres:16-alpine",
    });
    await until(() => said.length > 0);
    expect(said).toEqual([
      {
        task: "ACM-2",
        text: "Waiting for the acme-api environment, which ACM-1 uses now. ACM-2 is number 1 in line and starts when it is free.",
      },
    ]);
    // While it waits, ACM-2 has nothing: no network, no range, no container of its own, and ACM-1's are out of its reach.
    expect(service.taskNetworks("ACM-2")).toEqual([]);
    expect(service.taskSubnets("ACM-2")).toEqual([]);
    const refused = await service.taskDocker(
      "ACM-2",
      { argv: ["rm", "-f", "db"], cwd: join(dir, "tasks", "ACM-2") },
      { ask: async () => "pending" },
    );
    expect(refused.code).toBe(125);
    expect([...docker.containers.keys()].filter((n) => n.includes("-c-"))).toEqual(["majhi-acme-api-c-db"]);

    // ACM-1 stops running: its containers go and ACM-2 holds the environment.
    await service.taskPaused("ACM-1");
    expect((await second).status).toBe("started");
    expect(service.taskNetworks("ACM-1")).toEqual([]);
    expect(service.taskNetworks("ACM-2")).toEqual(["majhi-acme-api"]);
    expect(
      [...docker.containers.values()]
        .filter((c) => c.name.includes("-c-"))
        .map((c) => c.labels["majhi.task"]),
    ).toEqual(["ACM-2"]);
    expect(said.at(-1)?.text).toBe("The acme-api environment is free. ACM-2 has it now.");
    // The data stayed in the project's volume the whole time.
    expect(docker.volumes.has("majhi-acme-api-data-pgdata")).toBe(true);
  });
});

describe("a task's copy of the project database", () => {
  it("is made inside the service and dropped when the task closes", async () => {
    await service.serviceStart("ACM-1", "builder", db);
    expect(await service.branchDb("ACM-1", { service: "db" })).toEqual({
      database: "acm_1",
      template: "dev",
    });
    // Asking again is the same copy.
    await service.branchDb("ACM-1", { service: "db" });
    expect(docker.copyCalls).toEqual(["create acm_1 from dev in majhi-acme-api-c-db"]);

    await service.taskEnded("ACM-1");
    expect(docker.copyCalls).toEqual([
      "create acm_1 from dev in majhi-acme-api-c-db",
      "drop acm_1 in majhi-acme-api-c-db",
    ]);
  });
});

describe("a volume with no source", () => {
  it("becomes a named volume of the project, labelled with its workspace and project", async () => {
    const result = await service.taskDocker(
      "ACM-1",
      {
        argv: ["run", "-d", "--name", "db", "-v", "/var/lib/postgresql/data", "postgres:16-alpine"],
        cwd: join(dir, "tasks", "ACM-1"),
      },
      { ask: async () => "pending" },
    );
    expect(result.code).toBe(0);
    const [volume] = [...docker.volumes];
    expect(volume?.[0]).toMatch(/^majhi-acme-api-data-anon-[0-9a-f]{10}$/);
    expect(volume?.[1].labels).toEqual({
      "majhi.container": "volume",
      "majhi.org": "acme",
      "majhi.project": "acme-api",
    });
    const run = docker.taskCalls.find((c) => c[0] === "run") ?? [];
    expect(run).toContain(`type=volume,source=${volume?.[0]},target=/var/lib/postgresql/data`);
    expect(run.some((a) => a === "type=volume,target=/var/lib/postgresql/data")).toBe(false);
  });
});
