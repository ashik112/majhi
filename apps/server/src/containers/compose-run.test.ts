import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContainersSettings, ContainersSettingsSchema, type Task } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcessManager } from "../processes/manager.ts";
import { FakeDocker } from "../testing/fakeDocker.ts";
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

const task = (id: string): Task =>
  ({ id, folder: join(dir, "tasks", id), team: [], repos: [], org: "acme" }) as unknown as Task;

function build(): ContainerService {
  return new ContainerService({
    docker,
    processes,
    task: (id) => (id.startsWith("ACM-") ? task(id) : undefined),
    openTasks: () => ["ACM-1", "ACM-2"],
    settings: async () => settings,
    runnerNetwork: "majhi-runners",
    runnerImage: "majhi-runner:dev",
    guardServer: () => ({ host: "majhi-server", port: 7070 }),
    paths: {
      majhiHome: join(dir, "home", ".majhi"),
      hostHome: join(dir, "home"),
      protectedPaths: [join(dir, "keys", "secrets.key")],
    },
  });
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

describe("docker compose in a task", () => {
  it("starts each service behind a holder, in dependency order, and shows the owner nothing published", async () => {
    docker.containers.clear();
    const out = await up();
    expect(out.code).toBe(0);
    expect(out.stdout.split("\n").filter((l) => l !== "")).toEqual([
      " Container db  Started",
      " Container cache  Started",
      " Container app  Started",
    ]);
    expect(out.stderr).toContain("app: reach it from this task at app:8000");
    expect(names()).toEqual([
      "majhi-acm-1-c-app",
      "majhi-acm-1-c-cache",
      "majhi-acm-1-c-db",
      "majhi-acm-1-h-app",
      "majhi-acm-1-h-cache",
      "majhi-acm-1-h-db",
    ]);
    // Each holder was started with the guard before its container, on the runner network and the task network.
    expect(docker.holds).toHaveLength(3);
    for (const hold of docker.holds) {
      expect(hold).toEqual(expect.arrayContaining(["--network", "majhi-runners", "--cap-add", "NET_ADMIN"]));
      expect(hold.join(" ")).toContain("name=majhi-acm-1,alias=");
      expect(hold).not.toContain("--publish");
    }
    for (const run of docker.taskCalls.filter((c) => c[0] === "run")) {
      expect(run.join(" ")).toContain("--network container:majhi-acm-1-h-");
      expect(run).not.toContain("--publish");
      expect(run).toEqual(expect.arrayContaining(["--label", "majhi.container=taskrun"]));
    }
    // What was started is listed, and `up` again changes nothing.
    const ps = await call("ACM-1", repo, "compose", "ps");
    expect(ps.stdout).toContain("db");
    expect(ps.stdout).toContain("postgres:16-alpine");
    const again = await up();
    expect(again.stdout.split("\n").filter((l) => l !== "")).toEqual([
      " Container db  Running",
      " Container cache  Running",
      " Container app  Running",
    ]);
    expect(docker.holds).toHaveLength(3);
  });

  it("asks for each image that is not allowed, naming the service, and starts nothing", async () => {
    const out = await up(
      "services:\n  web:\n    image: nginx:1.27\n  db:\n    image: postgres:16-alpine\n  jobs:\n    image: mysql:8\n",
    );
    expect(out.code).toBe(1);
    expect(out.error?.code).toBe("image_not_allowed");
    expect(out.stderr).toContain("[image_not_allowed]");
    expect(asked.sort()).toEqual(["jobs mysql:8", "web nginx:1.27"]);
    expect(docker.containers.size).toBe(0);
    expect(docker.holds).toEqual([]);
  });

  it("refuses a stack larger than the task may run before it starts any of it", async () => {
    settings = { ...settings, per_task: 2 };
    const out = await up();
    expect(out.error?.code).toBe("limit_reached");
    expect(out.stderr).toContain("starts 3 containers");
    expect(docker.containers.size).toBe(0);
  });

  it("waits for a healthy dependency, and stops with a code when it dies", async () => {
    docker.containers.clear();
    const dead = await (async () => {
      // The database exits right away: the app is never started.
      const original = docker.task.bind(docker);
      docker.task = async (args, safety, allowed) => {
        const out = await original(args, safety, allowed);
        const db = docker.containers.get("majhi-acm-1-c-db");
        if (db !== undefined) db.state = "exited 1 none";
        return out;
      };
      const out = await up();
      docker.task = original;
      return out;
    })();
    expect(dead.error?.code).toBe("compose_dependency_failed");
    expect(dead.stderr).toContain("db stopped (exit 1) before it was healthy");
    expect(names().filter((n) => n.includes("-c-app"))).toEqual([]);
  });

  it("removes the containers and their holders on down, and down again is a no-op", async () => {
    await up();
    const out = await call("ACM-1", repo, "compose", "down");
    expect(out.stdout).toContain(" Container app  Removed");
    expect(names()).toEqual([]);
    const again = await call("ACM-1", repo, "compose", "down");
    expect(again).toMatchObject({ code: 0, stdout: "Nothing to remove.\n" });
  });

  it("stops a stack with the task and starts it again when the task runs, and forgets it after down or the end", async () => {
    await up();
    await service.taskPaused("ACM-1");
    expect(names()).toEqual([]);
    expect(await service.taskRunning("ACM-1")).toEqual({ started: ["compose in shop"], failed: [] });
    expect(names()).toHaveLength(6);
    // Once: a second resume starts nothing.
    expect(await service.taskRunning("ACM-1")).toEqual({ started: [], failed: [] });
    await call("ACM-1", repo, "compose", "down");
    await service.taskPaused("ACM-1");
    expect(await service.taskRunning("ACM-1")).toEqual({ started: [], failed: [] });
    expect(names()).toEqual([]);
    // A task that ends does not bring a stack back.
    await up();
    await service.taskPaused("ACM-1");
    await service.taskEnded("ACM-1");
    expect(await service.taskRunning("ACM-1")).toEqual({ started: [], failed: [] });
    expect(names()).toEqual([]);
  });

  it("keeps a task's compose containers invisible to every other task", async () => {
    await up();
    await writeFile(
      join(dir, "tasks", "ACM-2", "shop", "compose.yaml"),
      "services:\n  other:\n    image: alpine:3\n",
    );
    const cwd = join(dir, "tasks", "ACM-2", "shop");
    expect((await call("ACM-2", cwd, "compose", "ps")).stdout).toBe("SERVICE  IMAGE  STATUS\n");
    expect((await call("ACM-2", cwd, "ps", "-a", "--format", "{{.Names}}")).stdout).toBe("\n");
    expect(await call("ACM-2", cwd, "rm", "-f", "app")).toMatchObject({ code: 0 });
    expect(await call("ACM-2", cwd, "rm", "-f", "majhi-acm-1-c-app")).toMatchObject({ code: 0 });
    expect(await call("ACM-2", cwd, "compose", "exec", "app", "sh")).toMatchObject({ code: 1 });
    await call("ACM-2", cwd, "compose", "down");
    expect(names()).toContain("majhi-acm-1-c-app");
    expect(names()).toContain("majhi-acm-1-h-app");
  });

  it("refuses a file that asks for more than a task has, with a code, and starts nothing", async () => {
    const out = await up("services:\n  x:\n    image: alpine:3\n    privileged: true\n");
    expect(out).toMatchObject({ code: 125, error: { code: "compose_privileged" } });
    expect(out.stderr).toContain("docker: [compose_privileged]");
    const host = await up("services:\n  x:\n    image: alpine:3\n    network_mode: host\n");
    expect(host.error?.code).toBe("compose_host_network");
    expect(docker.holds).toEqual([]);
    expect(docker.containers.size).toBe(0);
  });
});

describe("a script's own containers", () => {
  const run = (...argv: string[]) => call("ACM-1", repo, "run", ...argv);

  it("removes the holder of a foreground container when it ends, and keeps the holder of a detached one", async () => {
    const quick = await run("--rm", "alpine:3", "echo", "hi");
    expect(quick.code).toBe(0);
    expect(names()).toEqual([]);
    const web = await run("-d", "--name", "web", "alpine:3", "sleep", "60");
    expect(web.code).toBe(0);
    expect(names()).toEqual(["majhi-acm-1-c-web", "majhi-acm-1-h-web"]);
    await call("ACM-1", repo, "rm", "-f", "web");
    expect(names()).toEqual([]);
  });

  it("leaves no holder behind when the container never started", async () => {
    docker.runFails.add("majhi-acm-1-c-gone");
    const out = await run("-d", "--name", "gone", "alpine:3");
    expect(out.code).toBe(125);
    expect(names()).toEqual([]);
  });

  it("starts nothing when the holder's guard does not come up", async () => {
    docker.failHolds.add("majhi-acm-1-h-web");
    const out = await run("-d", "--name", "web", "alpine:3");
    expect(out.code).toBe(125);
    expect(docker.taskCalls.filter((c) => c[0] === "run")).toEqual([]);
    expect(names()).toEqual([]);
  });

  it("drops -p with a note, maps --network to the task's network and reads --env-file from the task only", async () => {
    await writeFile(join(repo, ".env"), "A=1\n");
    const out = await run(
      "-d",
      "--name",
      "web",
      "-p",
      "8080:80",
      "--network",
      "backend",
      "--env-file",
      ".env",
      "alpine:3",
    );
    expect(out.code).toBe(0);
    expect(out.stderr).toContain("Nothing is published on the computer. From this task, reach it at web:80.");
    expect(out.stderr).toContain("--network is the task's own network, majhi-acm-1");
    const call_ = docker.taskCalls.find((c) => c[0] === "run") ?? [];
    expect(call_).toEqual(expect.arrayContaining(["--env", "A=1"]));
    expect(call_).not.toContain("--publish");
    const outside = await run("--env-file", join(dir, "keys", "x.env"), "alpine:3");
    expect(outside.error?.code).toBe("env_file_outside");
  });

  it("refuses a socket, a host network, a privileged flag and a folder outside the task with a code", async () => {
    const codes = async (...argv: string[]) => (await run(...argv, "alpine:3")).error?.code;
    expect(await codes("-v", "/var/run/docker.sock:/s")).toBe("socket_mount");
    expect(await codes("--network", "host")).toBe("host_network");
    expect(await codes("--privileged")).toBe("privileged");
    expect(await codes("--pid=host")).toBe("namespace_not_allowed");
    expect(await codes("--device", "/dev/sda")).toBe("device_not_allowed");
    expect(await codes("-v", "/etc:/h")).toBe("mount_outside");
    expect(docker.holds).toEqual([]);
  });

  it("removes every holder and container of a task that ended or after a restart, and only that task's", async () => {
    await run("-d", "--name", "a", "alpine:3");
    await up();
    await call("ACM-2", join(dir, "tasks", "ACM-2", "shop"), "run", "-d", "--name", "b", "alpine:3");
    expect(names().length).toBeGreaterThan(6);
    await service.taskEnded("ACM-1");
    expect(names()).toEqual(["majhi-acm-2-c-b", "majhi-acm-2-h-b"]);
    // A new server after a crash: nothing a task left is kept, whoever's it was, and a second sweep changes nothing.
    const restarted = build();
    await restarted.startup();
    expect(names()).toEqual([]);
    await restarted.startup();
    expect(names()).toEqual([]);
  });

  it("removes a holder whose container is gone, whatever ended it", async () => {
    await run("-d", "--name", "web", "alpine:3");
    docker.containers.delete("majhi-acm-1-c-web");
    // Any later call of the task sweeps it.
    await call("ACM-1", repo, "ps");
    await call("ACM-1", repo, "rm", "-f", "nothing");
    expect(names()).toEqual([]);
  });

  it("counts a container and its holder once against the task's limit", async () => {
    settings = { ...settings, per_task: 2 };
    expect((await run("-d", "--name", "a", "alpine:3")).code).toBe(0);
    expect((await run("-d", "--name", "b", "alpine:3")).code).toBe(0);
    const third = await run("-d", "--name", "c", "alpine:3");
    expect(third.error?.code).toBe("limit_reached");
    expect(names()).toEqual(["majhi-acm-1-c-a", "majhi-acm-1-c-b", "majhi-acm-1-h-a", "majhi-acm-1-h-b"]);
  });
});
