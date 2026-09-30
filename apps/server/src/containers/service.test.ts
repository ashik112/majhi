import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContainersSettings, ContainersSettingsSchema, type Task } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcessManager } from "../processes/manager.ts";
import { FakeDocker } from "../testing/fakeDocker.ts";
import { assertSafe, type DockerParts, dockerArgv, type Safety } from "./args.ts";
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
  docker = new FakeDocker();
  openTasks = ["ACM-1"];
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
  it("answers that containers need Docker when there is no docker", async () => {
    const off = build(undefined);
    expect(off.available()).toBe(false);
    await expect(off.serviceStart("ACM-1", "acme-builder", db)).rejects.toThrow(
      /need majhi running in Docker/,
    );
  });

  describe("images", () => {
    it("refuses an image the owner has not allowed, and asks through a card when it can", async () => {
      const input = { ...db, image: "mysql:8" };
      await expect(service.serviceStart("ACM-1", "acme-builder", input)).rejects.toThrow(/not allowed yet/);
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

    it("compares images after trim, with name equal to name:latest", async () => {
      settings = { ...settings, images: ["busybox"] };
      const started = await service.serviceStart("ACM-1", "acme-builder", {
        name: "box",
        image: "busybox:latest",
      });
      expect(started.status).toBe("started");
    });
  });

  describe("limits and names", () => {
    it("stops at containers.per_task, and does not count them against the process limit", async () => {
      settings = { ...settings, per_task: 7 };
      for (let i = 0; i < 6; i++)
        await service.serviceStart("ACM-1", "acme-builder", { name: `svc${i}`, image: "redis:7-alpine" });
      await service.serviceStart("ACM-1", "acme-builder", { name: "last", image: "redis:7-alpine" });
      await expect(
        service.serviceStart("ACM-1", "acme-builder", { name: "over", image: "redis:7-alpine" }),
      ).rejects.toThrow(/already runs 7 containers, the most it may \(7\)/);
      // Another task has its own count.
      await service.serviceStart("ACM-2", "acme-builder", { name: "cache", image: "redis:7-alpine" });
    });

    it("refuses a name that is taken, and frees it on stop", async () => {
      await service.serviceStart("ACM-1", "acme-builder", db);
      await expect(service.serviceStart("ACM-1", "acme-builder", db)).rejects.toThrow(/already runs/);
      const stopped = await service.stop("ACM-1", "db", "agent");
      expect(stopped.status).toBe("stopped");
      expect((await service.serviceStart("ACM-1", "acme-builder", db)).status).toBe("started");
    });
  });

  describe("the task network", () => {
    it("is made once, with the running runners joined, and runners of the task join it when they start", async () => {
      expect(service.taskNetworks("ACM-1")).toEqual([]);
      await service.serviceStart("ACM-1", "acme-builder", db);
      await service.serviceStart("ACM-1", "acme-builder", { name: "cache", image: "redis:7-alpine" });
      expect(docker.calls.filter((c) => c === "network create")).toHaveLength(1);
      expect(docker.connected).toContain("majhi-acm-1 majhi-run-aaa");
      expect(service.taskNetworks("ACM-1")).toEqual(["majhi-acm-1"]);
      expect(service.taskNetworks("ACM-2")).toEqual([]);
    });

    it("has services only, with no port published", async () => {
      await service.serviceStart("ACM-1", "acme-builder", db);
      const listed = service.list("ACM-1");
      expect(listed).toMatchObject([
        { kind: "service", name: "db", image: "postgres:16-alpine", url: "db:5432", status: "running" },
      ]);
    });
  });

  describe("volumes", () => {
    const withVolume = { ...db, volumes: [{ name: "pgdata", path: "/var/lib/postgresql/data" }] };

    it("creates the volume with the task's labels, and reuses it on the next start", async () => {
      await service.serviceStart("ACM-1", "acme-builder", withVolume);
      expect(docker.volumes.get("majhi-acm-1-data-pgdata")?.labels).toEqual({
        "majhi.container": "volume",
        "majhi.task": "ACM-1",
      });
      await service.stop("ACM-1", "db", "agent");
      await service.serviceStart("ACM-1", "acme-builder", withVolume);
      expect(docker.calls.filter((c) => c === "volume create")).toHaveLength(1);
    });

    it("refuses a volume that exists with other labels or with driver options", async () => {
      docker.volumes.set("majhi-acm-1-data-pgdata", {
        labels: { "majhi.task": "ACM-2", "majhi.container": "volume" },
        options: {},
      });
      await expect(service.serviceStart("ACM-1", "acme-builder", withVolume)).rejects.toThrow(
        /not one majhi made/,
      );
      docker.volumes.set("majhi-acm-1-data-pgdata", {
        labels: { "majhi.task": "ACM-1", "majhi.container": "volume" },
        options: { device: "/", type: "none", o: "bind" },
      });
      await expect(service.serviceStart("ACM-1", "acme-builder", withVolume)).rejects.toThrow(
        /not one majhi made/,
      );
      docker.volumes.set("majhi-acm-1-data-pgdata", { labels: {}, options: {} });
      await expect(service.serviceStart("ACM-1", "acme-builder", withVolume)).rejects.toThrow(
        /not one majhi made/,
      );
      expect(docker.containers.size).toBe(0);
    });
  });

  describe("the preview", () => {
    it("needs a built image, then runs it and shows where to reach it", async () => {
      await expect(
        service.previewRun("ACM-1", "acme-builder", { port: 7070, scratch: "/preview" }),
      ).rejects.toThrow(/Build it first with preview_build/);
      const build = await service.previewBuild("ACM-1", "acme-builder", { dockerfile: "Dockerfile" });
      expect(build).toMatchObject({ wait: true, container: { kind: "build" } });
      await expect(
        service.previewBuild("ACM-1", "acme-builder", { dockerfile: "Dockerfile" }),
      ).rejects.toThrow(/already building/);
      expect(docker.builders.has("majhi-preview-acm-1")).toBe(true);
      await until(() => processes.get("ACM-1", build.id)?.status === "exited");
      const run = await service.previewRun("ACM-1", "acme-builder", { port: 7070, scratch: "/preview" });
      expect(run).toMatchObject({
        kind: "preview",
        url: "http://majhi-preview-acm-1:7070",
        hostUrl: "http://127.0.0.1:49153",
      });
      // Running it again replaces it.
      const again = await service.previewRun("ACM-1", "acme-builder", { port: 7070, scratch: "/preview" });
      expect(again.process).not.toBe(run.process);
      expect(service.list("ACM-1").filter((c) => c.status === "running")).toHaveLength(1);
      // The builder is made once.
      await service.previewBuild("ACM-1", "acme-builder", { dockerfile: "Dockerfile" });
      expect(docker.calls.filter((c) => c === "buildx create")).toHaveLength(1);
    });

    it("refuses a repo that is not the task's and a Dockerfile outside its folder", async () => {
      await expect(
        service.previewBuild("ACM-1", "acme-builder", { dockerfile: "Dockerfile", repo: "web" }),
      ).rejects.toThrow(/no repo web/);
      await expect(
        service.previewBuild("ACM-1", "acme-builder", { dockerfile: "../../../../etc/passwd" }),
      ).rejects.toThrow(/inside the task folder/);
    });
  });

  describe("cleanup", () => {
    async function populate(): Promise<void> {
      docker.images.add("majhi-preview-acm-1");
      await service.serviceStart("ACM-1", "acme-builder", {
        ...db,
        volumes: [{ name: "pgdata", path: "/var/lib/postgresql/data" }],
      });
      await service.previewBuild("ACM-1", "acme-builder", { dockerfile: "Dockerfile" });
      await until(() => docker.images.has("majhi-preview-acm-1") && docker.builders.size > 0);
    }

    it("tasks.stop removes the containers and the network but keeps the volumes", async () => {
      await populate();
      await processes.stopTask("ACM-1");
      await service.taskStopped("ACM-1");
      expect(docker.containers.size).toBe(0);
      expect(docker.networks.size).toBe(0);
      expect(service.taskNetworks("ACM-1")).toEqual([]);
      expect(docker.volumes.has("majhi-acm-1-data-pgdata")).toBe(true);
      expect(docker.builders.size).toBe(1);
      expect(docker.images.size).toBe(1);
    });

    it("close and remove also remove the volumes, the builder and the preview image", async () => {
      await populate();
      await processes.stopTask("ACM-1");
      await service.taskEnded("ACM-1");
      expect(docker.containers.size).toBe(0);
      expect(docker.networks.size).toBe(0);
      expect(docker.volumes.size).toBe(0);
      expect(docker.builders.size).toBe(0);
      expect(docker.images.size).toBe(0);
    });

    it("startup removes leftovers, and the volumes, builders and images of tasks that are done or gone only", async () => {
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
