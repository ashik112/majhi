import { existsSync } from "node:fs";
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
 * `docker compose` and `docker run` of a task, through the container service with a fake docker:
 * what starts, in which names, behind which holder, and what stays of it afterwards.
 */

let dir: string;
let repo: string;
let docker: FakeDocker;
let processes: ProcessManager;
let service: ContainerService;
let settings: ContainersSettings;
let asked: string[];
let open: string[];

const task = (id: string): Task =>
  ({
    id,
    folder: join(dir, "tasks", id),
    team: [],
    repos: [{ project: id.toLowerCase() }],
    org: "acme",
  }) as unknown as Task;

function depsOf(): ConstructorParameters<typeof ContainerService>[0] {
  return {
    docker,
    processes,
    task: (id: string) => (id.startsWith("ACM-") ? task(id) : undefined),
    openTasks: () => open,
    queueWaitMs: async () => 30 * 60_000,
    allTasks: () => open,
    settings: async () => settings,
    runnerNetwork: "majhi-runners",
    runnerImage: "majhi-runner:dev",
    guardServer: () => ({ host: "majhi-server", port: 7070 }),
    paths: {
      majhiHome: join(dir, "home", ".majhi"),
      hostHome: join(dir, "home"),
      protectedPaths: [join(dir, "keys", "secrets.key")],
    },
  };
}

function build(): ContainerService {
  return new ContainerService(depsOf());
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "majhi-compose-run-"));
  repo = join(dir, "tasks", "ACM-1", "shop");
  await mkdir(repo, { recursive: true });
  await mkdir(join(dir, "tasks", "ACM-2", "shop"), { recursive: true });
  docker = new FakeDocker();
  settings = ContainersSettingsSchema.parse({
    images: ["postgres:16-alpine", "redis:7-alpine", "alpine:3"],
    per_task: 4,
  });
  processes = new ProcessManager({
    spawner: async () => {
      throw new Error("unused");
    },
    launch: async () => {
      throw new Error("unused");
    },
    throttleMs: 5,
  });
  service = build();
  asked = [];
  open = ["ACM-1", "ACM-2"];
});
afterEach(async () => {
  await processes.stopAll();
  await rm(dir, { recursive: true, force: true });
});

const STACK = `services:
  app:
    image: alpine:3
    ports: ["8000:8000"]
    depends_on:
      db: {condition: service_healthy}
      cache: {condition: service_started}
  db:
    image: postgres:16-alpine
    healthcheck:
      test: ["CMD-SHELL", "pg_isready"]
  cache:
    image: redis:7-alpine
`;

const ask = async (image: string, name?: string) => {
  asked.push(`${name ?? "?"} ${image}`);
  return "pending" as const;
};
const call = (id: string, cwd: string, ...argv: string[]) => service.taskDocker(id, { argv, cwd }, { ask });
const names = () => [...docker.containers.keys()].sort();

async function up(file = STACK, id = "ACM-1") {
  await writeFile(join(dir, "tasks", id, "shop", "compose.yaml"), file);
  return call(id, join(dir, "tasks", id, "shop"), "compose", "up", "-d");
}

describe("the builder's network", () => {
  const dockerfile = () => writeFile(join(repo, "Dockerfile"), "FROM alpine:3\n");
  const build = () => call("ACM-1", repo, "build", "-t", "web:test", ".");

  it("fails closed: no build runs when the guard cannot be set", async () => {
    await dockerfile();
    docker.failBuilderGuard = true;
    const out = await build();
    expect(out.code).not.toBe(0);
    expect(docker.taskCalls.filter((c) => c[0] === "buildx")).toEqual([]);
  });
});
