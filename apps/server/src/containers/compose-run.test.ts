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
  ({ id, folder: join(dir, "tasks", id), team: [], repos: [], org: "acme" }) as unknown as Task;

function depsOf(): ConstructorParameters<typeof ContainerService>[0] {
  return {
    docker,
    processes,
    task: (id: string) => (id.startsWith("ACM-") ? task(id) : undefined),
    openTasks: () => open,
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

describe("the docker CLIs a call spawns before it is planned", () => {
  it("looks at no more than 8 container ids of one call", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(12, "a"));
    await call("ACM-1", repo, "rm", "-f", ...ids);
    expect(docker.calls.filter((c) => c === "inspect --format")).toHaveLength(8);
  });

  it("holds at most 16 calls of a task in that stage, and answers the next one with a refusal", async () => {
    let open: () => void = () => undefined;
    docker.imageListGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const held = Array.from({ length: 16 }, () => call("ACM-1", repo, "ps"));
    const over = await call("ACM-1", repo, "ps");
    expect(over.error?.code).toBe("limit_reached");
    open();
    expect((await Promise.all(held)).every((r) => r.error === undefined)).toBe(true);
    expect((await call("ACM-1", repo, "ps")).error).toBeUndefined();
  });
});

describe("builds in a task", () => {
  const dockerfile = (text: string) => writeFile(join(repo, "Dockerfile"), text);
  const build = (...extra: string[]) => call("ACM-1", repo, "build", "-t", "web:test", ...extra, ".");

  it("pulls only images the owner allowed or the task built: every FROM, COPY --from, mount and # syntax=", async () => {
    for (const text of [
      "FROM node:22\n",
      "FROM alpine:3 AS a\nCOPY --from=nginx:1.27 /x /x\n",
      "# syntax=docker/dockerfile:1.7\nFROM alpine:3\n",
      "ARG BASE=mysql:8\nFROM ${BASE}\n",
    ]) {
      await dockerfile(text);
      const out = await build();
      expect(out.error?.code, text).toBe("image_not_allowed");
    }
    expect(docker.taskCalls.filter((c) => c[0] === "buildx")).toEqual([]);
    // Each image asks the owner, once, and the card has no container name.
    expect(asked).toEqual(
      expect.arrayContaining(["? node:22", "? nginx:1.27", "? docker/dockerfile:1.7", "? mysql:8"]),
    );
  });

  it("builds with allowed images, stages of its own and an image the task built before", async () => {
    await dockerfile("FROM alpine:3 AS base\nFROM postgres:16-alpine\nCOPY --from=base /a /a\n");
    expect((await build()).code).toBe(0);
    docker.images.add("majhi-acm-1-img-web:test");
    await dockerfile("FROM web:test\n");
    expect((await build()).code).toBe(0);
    // A build argument changes what ARG resolves to.
    await dockerfile("ARG BASE=alpine:3\nFROM ${BASE}\n");
    expect((await build()).code).toBe(0);
    expect((await build("--build-arg", "BASE=node:22")).error?.code).toBe("image_not_allowed");
  });

  it("builds the bytes it checked, from a file outside the task, gone after the build", async () => {
    await dockerfile("FROM alpine:3\n");
    // The task rewrites its Dockerfile after the check and before BuildKit reads it.
    docker.beforeBuild = () => dockerfile("FROM node:22\n");
    expect((await build()).code).toBe(0);
    const [read] = docker.builtDockerfiles;
    expect(read?.text).toBe("FROM alpine:3\n");
    expect(read?.file.startsWith(repo)).toBe(false);
    expect(existsSync(read?.file ?? repo)).toBe(false);
    // A snapshot path is never a way to name a file: a call that names one is outside the task folder.
    const named = await call("ACM-1", repo, "build", "-t", "web:test", "-f", read?.file ?? "/x", ".");
    expect(named.code).not.toBe(0);
  });

  it("refuses a BUILDKIT_ build argument: BUILDKIT_SYNTAX would load any image as the Dockerfile's frontend", async () => {
    await dockerfile("FROM alpine:3\n");
    const out = await build("--build-arg", "BUILDKIT_SYNTAX=evil/frontend:1");
    expect(out.error?.code).toBe("flag_not_allowed");
    expect(docker.taskCalls.filter((c) => c[0] === "buildx")).toEqual([]);
    await mkdir(join(repo, "app"), { recursive: true });
    await writeFile(join(repo, "app", "Dockerfile"), "FROM alpine:3\n");
    const stack = await up(
      "services:\n  app:\n    build:\n      context: ./app\n      args:\n        BUILDKIT_SYNTAX: evil/frontend:1\n",
    );
    expect(stack.error?.code).toBe("flag_not_allowed");
    expect(docker.taskCalls.filter((c) => c[0] === "buildx")).toEqual([]);
  });

  it("refuses a Dockerfile that is not there or not a file, and one it cannot read the images of", async () => {
    await rm(join(repo, "Dockerfile"), { force: true });
    expect((await build()).code).not.toBe(0);
    await dockerfile("FROM ${NOPE}\n");
    expect((await build()).error?.code).toBe("image_not_allowed");
  });

  it("refuses a compose stack whose build pulls an image nobody allowed, naming the service, before any start", async () => {
    await mkdir(join(repo, "app"), { recursive: true });
    await writeFile(join(repo, "app", "Dockerfile"), "FROM node:22\n");
    const out = await up("services:\n  db:\n    image: postgres:16-alpine\n  app:\n    build: ./app\n");
    expect(out.error?.code).toBe("image_not_allowed");
    expect(asked).toEqual(["app node:22"]);
    expect(docker.holds).toEqual([]);
    expect(names()).toEqual([]);
  });
});

describe("the builder's network", () => {
  const dockerfile = () => writeFile(join(repo, "Dockerfile"), "FROM alpine:3\n");
  const build = () => call("ACM-1", repo, "build", "-t", "web:test", ".");

  it("is closed to private destinations before a build runs on it, at every start of the builder", async () => {
    await dockerfile();
    expect((await build()).code).toBe(0);
    expect(docker.builderGuards).toHaveLength(1);
    const guard = docker.builderGuards[0] ?? [];
    expect(guard).toEqual(
      expect.arrayContaining([
        "--network",
        "container:buildx_buildkit_majhi-preview-acm-10",
        "--cap-add",
        "NET_ADMIN",
        "--pull",
        "never",
      ]),
    );
    expect(guard.slice(-3)).toEqual(["majhi-runner:dev", "node", "/usr/local/lib/majhi/netguard.mjs"]);
    expect(guard.join(" ")).not.toContain("--publish");
    // A builder stops when its build ends and starts with a new network: every start is guarded again.
    await build();
    expect(docker.builderGuards).toHaveLength(2);
  });

  it("fails closed: no build runs when the guard cannot be set", async () => {
    await dockerfile();
    docker.failBuilderGuard = true;
    const out = await build();
    expect(out.code).not.toBe(0);
    expect(docker.taskCalls.filter((c) => c[0] === "buildx")).toEqual([]);
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

  /** Plays a container that ended on its own: its status says so and docker keeps it (no --rm). */
  const ends = (name: string) => {
    const c = docker.containers.get(`majhi-acm-1-c-${name}`);
    if (c === undefined) throw new Error(`no ${name}`);
    c.status = "Exited (0) 1 second ago";
    c.state = "exited 0 none";
  };

  it("counts a container that ended and was not removed, so exited ones cannot pile up past the limit", async () => {
    settings = { ...settings, per_task: 2 };
    await run("-d", "--name", "a", "alpine:3");
    await run("-d", "--name", "b", "alpine:3");
    ends("a");
    ends("b");
    const third = await run("-d", "--name", "c", "alpine:3");
    expect(third.error?.code).toBe("limit_reached");
    // Removing one frees its slot.
    await call("ACM-1", repo, "rm", "a");
    expect((await run("-d", "--name", "c", "alpine:3")).code).toBe(0);
  });

  it("removes the holder of a container that ended, and refuses to start it again", async () => {
    await run("-d", "--name", "a", "alpine:3");
    expect(names()).toEqual(["majhi-acm-1-c-a", "majhi-acm-1-h-a"]);
    ends("a");
    const started = await call("ACM-1", repo, "start", "a");
    expect(started.error?.code).toBe("restart_not_available");
    expect(names()).toEqual(["majhi-acm-1-c-a"]);
    expect(docker.taskCalls.filter((c) => c[0] === "start")).toEqual([]);
  });

  it("lets only as many starts through as the global limit allows when tasks start in parallel", async () => {
    settings = { ...settings, total: 1 };
    docker.psDelayMs = 25;
    const results = await Promise.all([
      call("ACM-1", repo, "run", "-d", "--name", "a", "alpine:3"),
      call("ACM-2", join(dir, "tasks", "ACM-2", "shop"), "run", "-d", "--name", "b", "alpine:3"),
      call("ACM-1", repo, "run", "-d", "--name", "c", "alpine:3"),
    ]);
    expect(results.map((r) => r.code).sort()).toEqual([0, 125, 125]);
    expect([...docker.containers.keys()].filter((n) => n.includes("-c-"))).toHaveLength(1);
  });

  it("refuses a name a running process of the task already answers to, and one a container already has", async () => {
    const running = {
      id: "p1",
      task: "ACM-1",
      agent: "a",
      name: "web",
      command: "x",
      cwd: repo,
      wait: false,
      status: "running",
      startedAt: new Date().toISOString(),
      tail: [],
      host: "web",
    };
    const spy = {
      list: (t: string) => (t === "ACM-1" ? [running] : []),
      listAll: () => [running],
      get: () => running,
      stopAll: async () => undefined,
    } as unknown as ProcessManager;
    service = new ContainerService({ ...depsOf(), processes: spy });
    const out = await run("-d", "--name", "web", "alpine:3");
    expect(out.error?.code).toBe("name_reserved");
    expect(out.stderr).toContain("p1");
    expect(names()).toEqual([]);
    expect(await service.hostNameTaken("ACM-1", "preview")).toBe(true);
    expect(await service.hostNameTaken("ACM-1", "devserver")).toBe(false);
    // A second container of a name that is taken is refused and the first keeps its holder.
    service = build();
    expect((await run("-d", "--name", "db", "alpine:3")).code).toBe(0);
    const again = await run("-d", "--name", "db", "alpine:3");
    expect(again.error?.code).toBe("name_in_use");
    expect(names()).toEqual(["majhi-acm-1-c-db", "majhi-acm-1-h-db"]);
    expect(await service.hostNameTaken("ACM-1", "db")).toBe(true);
  });

  it("starts nothing for a task that is done, and a start that was waiting when it ended leaves nothing behind", async () => {
    open = ["ACM-2"];
    const refusedStart = await run("-d", "--name", "late", "alpine:3");
    expect(refusedStart.error?.code).toBe("task_not_open");
    expect((await up()).error?.code).toBe("task_not_open");
    expect(names()).toEqual([]);
    // The task ends while a start is in flight (docker answers slowly): the end waits for it, then removes it.
    open = ["ACM-1", "ACM-2"];
    docker.psDelayMs = 30;
    const inFlight = run("-d", "--name", "racing", "alpine:3");
    await new Promise((r) => setTimeout(r, 10));
    open = ["ACM-2"];
    await service.taskEnded("ACM-1");
    await inFlight;
    docker.psDelayMs = 0;
    expect(names()).toEqual([]);
  });

  it("caps the docker calls of a task that wait at once", async () => {
    let release: () => void = () => undefined;
    docker.waitGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waits = Array.from({ length: 17 }, (_, i) => call("ACM-1", repo, "wait", `c${i}`));
    // The sixteen that fit are inside docker, held at the gate; the last is refused at once.
    await until(() => docker.taskCalls.filter((c) => c[0] === "wait").length === 16);
    expect((await waits[16])?.error?.code).toBe("limit_reached");
    release();
    const done = await Promise.all(waits);
    expect(done.filter((r) => r?.error?.code === "limit_reached")).toHaveLength(1);
    expect(done.filter((r) => r?.code === 0)).toHaveLength(16);
    // Another task has its own allowance.
    docker.waitGate = undefined;
    expect((await call("ACM-2", join(dir, "tasks", "ACM-2", "shop"), "wait", "x")).code).toBe(0);
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
