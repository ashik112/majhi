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
    queueWaitMs: async () => 30 * 60_000,
    allTasks: () => ["ACM-1", "ACM-2", "ACM-3", "ACM-4", "ACM-5", "ACM-6"],
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
    repos: [{ project: id.toLowerCase(), worktree: join(dir, "tasks", id, "api") }],
    // ACM-3 was done just now; every other task a month ago.
    updatedAt: id === "ACM-3" ? new Date().toISOString() : "2026-01-01T00:00:00.000Z",
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
      const input = { ...db, image: "acme/mysql:8" };
      await expect(service.serviceStart("ACM-1", "acme-builder", input)).rejects.toThrow();
      const asked: string[] = [];
      const pending = await service.serviceStart("ACM-1", "acme-builder", input, async (image) => {
        asked.push(image);
        return "pending";
      });
      expect(pending).toEqual({ status: "asked" });
      expect(asked).toEqual(["acme/mysql:8"]);
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
});
