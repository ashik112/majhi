import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContainersSettings, ContainersSettingsSchema, type Task } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcessManager } from "../processes/manager.ts";
import { FakeDocker } from "../testing/fakeDocker.ts";
import { type ContainerDocker, ContainerService } from "./service.ts";

let dir: string;
let docker: FakeDocker;
let processes: ProcessManager;
let service: ContainerService;
let settings: ContainersSettings;
let openTasks: string[];
let folder: string;

function build(withDocker: ContainerDocker | undefined): ContainerService {
  return new ContainerService({
    docker: withDocker,
    processes,
    task: (id) => (id.startsWith("ACM-") ? task(id) : undefined),
    openTasks: () => openTasks,
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
}

const task = (id: string): Task =>
  ({
    id,
    folder: join(dir, "tasks", id),
    team: ["acme-builder"],
    repos: [{ project: "api", worktree: join(dir, "tasks", id, "api") }],
  }) as unknown as Task;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "majhi-containers-svc-"));
  folder = join(dir, "tasks", "ACM-1");
  await mkdir(join(folder, "api"), { recursive: true });
  await mkdir(join(dir, "tasks", "ACM-2", "api"), { recursive: true });
  for (const id of ["ACM-1", "ACM-2"])
    await writeFile(join(dir, "tasks", id, "api", "Dockerfile"), "FROM scratch\n");
  docker = new FakeDocker();
  openTasks = ["ACM-1", "ACM-2"];
  settings = ContainersSettingsSchema.parse({ images: ["postgres:16-alpine", "redis:7-alpine"] });
  processes = new ProcessManager({
    spawner: async () => {
      throw new Error("A container is not run by the runner spawner.");
    },
    launch: async () => {
      throw new Error("A container has no launch settings.");
    },
    throttleMs: 5,
  });
  service = build(docker);
});

afterEach(async () => {
  await processes.stopAll();
  await rm(dir, { recursive: true, force: true });
});

const db = { name: "db", image: "postgres:16-alpine", port: 5432 };

describe("ContainerService", () => {
  describe("images", () => {
    it("refuses an image the owner has not allowed, and asks through a card when it can", async () => {
      const input = { ...db, image: "mysql:8" };
      await expect(service.serviceStart("ACM-1", "acme-builder", input)).rejects.toThrow();
      const asked: string[] = [];
      const pending = await service.serviceStart("ACM-1", "acme-builder", input, async (image) => {
        asked.push(image);
        return "pending";
      });
      expect(pending).toEqual({ status: "asked" });
      expect(asked).toEqual(["mysql:8"]);
      expect(docker.networks.size).toBe(0);
      expect(docker.containers.size).toBe(0);
      // A rule or an auto mode runs the card at once: the image is allowed when the call returns.
      const started = await service.serviceStart("ACM-1", "acme-builder", input, async (image) => {
        settings = { ...settings, images: [...settings.images, image] };
        return "allowed";
      });
      expect(started.status).toBe("started");
    });
  });

  describe("a preview's Dockerfile", () => {
    it("pulls only images the owner allowed: it asks for the rest and builds nothing", async () => {
      await writeFile(
        join(dir, "tasks", "ACM-1", "api", "Dockerfile"),
        "FROM node:22 AS build\nFROM redis:7-alpine\n",
      );
      const asked: string[] = [];
      await expect(
        service.previewBuild("ACM-1", "acme-builder", { dockerfile: "Dockerfile" }, async (image) => {
          asked.push(image);
          return "pending";
        }),
      ).rejects.toThrow(/node:22/);
      expect(asked).toEqual(["node:22"]);
      expect(docker.builders.size).toBe(0);
      await expect(
        service.previewBuild("ACM-1", "acme-builder", { dockerfile: "Dockerfile" }),
      ).rejects.toThrow(/Allow them first/);
    });
  });

  describe("limits and names", () => {
    it("reserves a global slot before concurrent starts, and releases it when a container stops", async () => {
      settings = { ...settings, total: 1 };
      const results = await Promise.allSettled([
        service.serviceStart("ACM-1", "acme-builder", db),
        service.serviceStart("ACM-2", "acme-builder", db),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      // One service: its holder and its container.
      expect(docker.containers.size).toBe(2);
      const live = processes.listAll().find((c) => c.status === "running");
      expect(live).toBeDefined();
      const runningTask = [...docker.containers.keys()][0]?.includes("acm-1") ? "ACM-1" : "ACM-2";
      await service.stop(runningTask, "db", "owner");
      expect(
        (await service.serviceStart(runningTask === "ACM-1" ? "ACM-2" : "ACM-1", "acme-builder", db)).status,
      ).toBe("started");
    });

    it("limits concurrent builds across tasks before allocating builders", async () => {
      settings = { ...settings, build_total: 1 };
      const results = await Promise.allSettled([
        service.previewBuild("ACM-1", "acme-builder", { dockerfile: "Dockerfile" }),
        service.previewBuild("ACM-2", "acme-builder", { dockerfile: "Dockerfile" }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(docker.builders.size).toBe(1);
      await until(() => processes.listAll().every((p) => p.status !== "running"));
      expect(await service.previewBuild("ACM-2", "acme-builder", { dockerfile: "Dockerfile" })).toMatchObject(
        { container: { kind: "build" } },
      );
    });

    it("stops at containers.per_task, and does not count them against the process limit", async () => {
      settings = { ...settings, per_task: 7 };
      for (let i = 0; i < 6; i++)
        await service.serviceStart("ACM-1", "acme-builder", { name: `svc${i}`, image: "redis:7-alpine" });
      await service.serviceStart("ACM-1", "acme-builder", { name: "last", image: "redis:7-alpine" });
      await expect(
        service.serviceStart("ACM-1", "acme-builder", { name: "over", image: "redis:7-alpine" }),
      ).rejects.toThrow();
      // Another task has its own count.
      await service.serviceStart("ACM-2", "acme-builder", { name: "cache", image: "redis:7-alpine" });
    });
  });

  describe("volumes", () => {
    const withVolume = { ...db, volumes: [{ name: "pgdata", path: "/var/lib/postgresql/data" }] };

    it("refuses a volume that exists with other labels or with driver options", async () => {
      docker.volumes.set("majhi-acm-1-data-pgdata", {
        labels: { "majhi.task": "ACM-2", "majhi.container": "volume" },
        options: {},
      });
      await expect(service.serviceStart("ACM-1", "acme-builder", withVolume)).rejects.toThrow();
      docker.volumes.set("majhi-acm-1-data-pgdata", {
        labels: { "majhi.task": "ACM-1", "majhi.container": "volume" },
        options: { device: "/", type: "none", o: "bind" },
      });
      await expect(service.serviceStart("ACM-1", "acme-builder", withVolume)).rejects.toThrow();
      docker.volumes.set("majhi-acm-1-data-pgdata", { labels: {}, options: {} });
      await expect(service.serviceStart("ACM-1", "acme-builder", withVolume)).rejects.toThrow();
      expect(docker.containers.size).toBe(0);
    });
  });

  describe("the preview", () => {
    it("refuses a repo that is not the task's and a Dockerfile outside its folder", async () => {
      await expect(
        service.previewBuild("ACM-1", "acme-builder", { dockerfile: "Dockerfile", repo: "web" }),
      ).rejects.toThrow();
      await expect(
        service.previewBuild("ACM-1", "acme-builder", { dockerfile: "../../../../etc/passwd" }),
      ).rejects.toThrow();
    });
  });

  describe("the network guard", () => {
    it("tells a runner that was already up the task network's subnet when the network is made, and the server with it", async () => {
      expect(service.taskSubnets("ACM-1")).toEqual([]);
      await service.serviceStart("ACM-1", "acme-builder", db);
      expect(service.taskSubnets("ACM-1")).toEqual(["192.168.171.0/24"]);
      expect(docker.guards).toEqual(["majhi-run-aaa: 192.168.171.0/24 majhi-server:7070"]);
    });

    it("starts a preview's holder on the task network, which it makes first, and names it preview there", async () => {
      docker.images.add("majhi-preview-acm-1");
      const info = await service.previewRun("ACM-1", "acme-builder", { port: 7070, scratch: "/preview" });
      expect(info.url).toBe("http://preview:7070");
      expect(service.taskSubnets("ACM-1")).toEqual(["192.168.171.0/24"]);
      const holder = [...docker.containers.values()].find(
        (c) => c.labels["majhi.container"] === "previewhold",
      );
      expect(holder?.name).toBe("majhi-preview-acm-1");
      expect(service.taskSubnets("ACM-2")).toEqual([]);
    });

    it("forgets the subnets, and clears them from a runner that is still up, when the task stops", async () => {
      await service.serviceStart("ACM-1", "acme-builder", db);
      docker.guards.length = 0;
      await service.taskStopped("ACM-1");
      expect(service.taskSubnets("ACM-1")).toEqual([]);
      expect(docker.guards).toEqual(["majhi-run-aaa:  majhi-server:7070"]);
    });
  });

  describe("a task that stops running and runs again", () => {
    const withVolume = { ...db, volumes: [{ name: "pgdata", path: "/var/lib/postgresql/data" }] };

    async function upWithPreview(): Promise<void> {
      await service.serviceStart("ACM-1", "acme-builder", withVolume);
      await service.serviceStart("ACM-1", "acme-builder", { name: "cache", image: "redis:7-alpine" });
      docker.images.add("majhi-preview-acm-1");
      await service.previewRun("ACM-1", "acme-builder", { port: 7070, scratch: "/preview" });
      expect([...docker.containers.keys()].sort()).toEqual([
        "majhi-acm-1-c-cache",
        "majhi-acm-1-c-db",
        "majhi-acm-1-h-cache",
        "majhi-acm-1-h-db",
        "majhi-preview-acm-1",
        "majhi-preview-acm-1-app",
      ]);
    }

    it("stops its services and preview on review or pause, keeps the volumes, and starts them again on resume", async () => {
      await upWithPreview();
      await service.taskPaused("ACM-1");
      expect(docker.containers.size).toBe(0);
      expect(docker.networks.size).toBe(0);
      expect(docker.volumes.has("majhi-acm-1-data-pgdata")).toBe(true);
      // Paused again (review, then stop): nothing is forgotten.
      await service.taskPaused("ACM-1");

      const again = await service.taskRunning("ACM-1");
      expect(again).toEqual({ started: ["db", "cache", "preview"], failed: [] });
      expect([...docker.containers.keys()].sort()).toEqual([
        "majhi-acm-1-c-cache",
        "majhi-acm-1-c-db",
        "majhi-acm-1-h-cache",
        "majhi-acm-1-h-db",
        "majhi-preview-acm-1",
        "majhi-preview-acm-1-app",
      ]);
      // The same volume, with its data, and the task network made again.
      expect(docker.calls.filter((c) => c === "volume create")).toHaveLength(1);
      expect(service.taskNetworks("ACM-1")).toEqual(["majhi-acm-1"]);
      expect(service.list("ACM-1").filter((c) => c.status === "running")).toHaveLength(3);
      // Once: a second resume starts nothing.
      expect(await service.taskRunning("ACM-1")).toEqual({ started: [], failed: [] });
    });

    it("keeps only unsaved service data while stopping the preview and volume-backed services", async () => {
      await upWithPreview();
      // "cache" has no volume: stopping would lose its data.
      expect(await service.taskPaused("ACM-1", { keepUnsaved: true })).toEqual({ kept: ["cache"] });
      expect([...docker.containers.keys()].sort()).toEqual(["majhi-acm-1-c-cache", "majhi-acm-1-h-cache"]);
      expect(docker.volumes.has("majhi-acm-1-data-pgdata")).toBe(true);
      expect(await service.taskRunning("ACM-1")).toEqual({ started: ["db", "preview"], failed: [] });
      // The owner's Stop still ends them all.
      expect(await service.taskPaused("ACM-1")).toEqual({ kept: [] });
      expect(docker.containers.size).toBe(0);
    });
  });

  describe("a start right after a restart", () => {
    it("waits for the startup cleanup, so the cleanup does not sweep the new container away", async () => {
      docker.psDelayMs = 60;
      const cleaning = service.startup();
      const started = await service.serviceStart("ACM-1", "acme-builder", db);
      await cleaning;
      expect(started.status).toBe("started");
      expect(docker.containers.has("majhi-acm-1-c-db")).toBe(true);
    });
  });

  describe("cleanup", () => {
    it("startup removes leftovers, and the volumes, builders and images of tasks that are done or gone only", async () => {
      openTasks = ["ACM-1"];
      docker.containers.set("majhi-acm-1-db", {
        name: "majhi-acm-1-db",
        labels: { "majhi.container": "service", "majhi.task": "ACM-1" },
        child: undefined,
      });
      docker.networks.set("majhi-acm-1", new Set(["majhi-run-aaa"]));
      for (const t of ["ACM-1", "ACM-2", "ACM-9"]) {
        docker.volumes.set(`majhi-${t.toLowerCase()}-data-x`, {
          labels: { "majhi.container": "volume", "majhi.task": t },
          options: {},
        });
        docker.builders.add(`majhi-preview-${t.toLowerCase()}`);
        docker.images.add(`majhi-preview-${t.toLowerCase()}`);
      }
      await service.startup();
      expect(docker.containers.size).toBe(0);
      expect(docker.networks.size).toBe(0);
      // The builder of the open task stops, and starts again on its next build; the others are gone.
      expect(docker.stoppedBuilders).toEqual(["majhi-preview-acm-1"]);
      // ACM-1 is open; ACM-2 is done and ACM-9 is gone.
      expect([...docker.volumes.keys()]).toEqual(["majhi-acm-1-data-x"]);
      expect([...docker.builders]).toEqual(["majhi-preview-acm-1"]);
      expect([...docker.images]).toEqual(["majhi-preview-acm-1"]);
    });
  });
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out");
}
