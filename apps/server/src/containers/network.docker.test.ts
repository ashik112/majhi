import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type ContainersSettings, ContainersSettingsSchema, type Task } from "@majhi/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProcessManager } from "../processes/manager.ts";
import { DockerCli } from "./docker.ts";
import { ContainerService } from "./service.ts";

/**
 * The task network against a real Docker daemon: what a task's containers can and cannot reach.
 * Skipped when there is no daemon or no runner image. Throwaway tasks (ZZT-911, ZZT-912) and a
 * throwaway runner network; everything is removed at the end, by label.
 */

/** The runner image holds the guard. Containers run a copy under another name: an image named `majhi-` is never allowed to a task. */
const RUNNER = "majhi-runner:dev";
const IMAGE = "zzt-probe:dev";
const A = "ZZT-911";
const B = "ZZT-912";

const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8" });
const ready = docker("image", "inspect", RUNNER).status === 0;

const dir = mkdtempSync(join(tmpdir(), "majhi-net-"));
const runners = `majhitest-${randomBytes(3).toString("hex")}`;
const folderOf = (id: string) => join(dir, "tasks", id);
let settings: ContainersSettings;
let service: ContainerService;
let processes: ProcessManager;

function make(openTasks: string[]): ContainerService {
  return new ContainerService({
    docker: new DockerCli({
      cliEnv: { PATH: process.env.PATH ?? "" },
      majhiHome: join(dir, "home", ".majhi"),
      hostHome: join(dir, "home"),
      protectedPaths: [],
    }),
    processes,
    task: (id) => ({ id, folder: folderOf(id), repos: [], org: "acme" }) as unknown as Task,
    openTasks: () => openTasks,
    settings: async () => settings,
    runnerNetwork: runners,
    runnerImage: RUNNER,
    paths: { majhiHome: join(dir, "home", ".majhi"), hostHome: join(dir, "home"), protectedPaths: [] },
  });
}

const run = (id: string, ...argv: string[]) =>
  service.taskDocker(id, { argv, cwd: folderOf(id) }, { ask: async () => "pending" });
const ids = (task: string) =>
  docker("ps", "-aq", "--filter", `label=majhi.task=${task}`).stdout.split("\n").filter(Boolean);
const names = (task: string) =>
  docker("ps", "-a", "--filter", `label=majhi.task=${task}`, "--format", "{{.Names}}")
    .stdout.split("\n")
    .filter(Boolean)
    .sort();
const addresses = (container: string) =>
  docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", container)
    .stdout.trim()
    .split(" ")
    .filter(Boolean);
/** Connects from inside a container with python: CONNECTED, or what stopped it. */
const connect = (container: string, host: string, port: number) =>
  docker(
    "exec",
    container,
    "python3",
    "-c",
    `import socket\ns=socket.socket();s.settimeout(5)\ntry:\n s.connect(("${host}",${port}));print("CONNECTED")\nexcept Exception as e:\n print("BLOCKED",type(e).__name__)`,
  ).stdout.trim();

function sweep() {
  for (const task of [A, B]) {
    const found = ids(task);
    if (found.length > 0) docker("rm", "-f", "-v", ...found);
    const volumes = docker("volume", "ls", "-q", "--filter", `label=majhi.task=${task}`)
      .stdout.split("\n")
      .filter(Boolean);
    if (volumes.length > 0) docker("volume", "rm", "-f", ...volumes);
    docker("network", "rm", `majhi-${task.toLowerCase()}`);
  }
  docker("network", "rm", runners);
}

beforeAll(() => {
  if (!ready) return;
  sweep();
  for (const task of [A, B]) mkdirSync(folderOf(task), { recursive: true });
  writeFileSync(
    join(folderOf(A), "compose.yaml"),
    "services:\n  web:\n    image: zzt-probe:dev\n    command: python3 -m http.server 8080\n    ports: ['8080:8080']\n  api:\n    image: zzt-probe:dev\n    command: sleep 600\n    depends_on: [web]\n",
  );
  execFileSync("docker", ["network", "create", runners]);
  execFileSync("docker", ["tag", RUNNER, IMAGE]);
  settings = ContainersSettingsSchema.parse({ images: [IMAGE, "alpine:3"] });
  // The docker CLI majhi runs keeps its own config folder; buildx lives in the user's plugin folder here.
  const plugins = join(homedir(), ".docker", "cli-plugins");
  if (existsSync(plugins)) {
    mkdirSync(join(dir, "home", ".majhi", "cache", "docker"), { recursive: true });
    symlinkSync(plugins, join(dir, "home", ".majhi", "cache", "docker", "cli-plugins"));
  }
  processes = new ProcessManager({
    spawner: async () => {
      throw new Error("unused");
    },
    launch: async () => {
      throw new Error("unused");
    },
  });
  service = make([A, B]);
}, 120_000);

afterAll(async () => {
  if (ready) {
    await service.taskEnded(A).catch(() => undefined);
    await service.taskEnded(B).catch(() => undefined);
    sweep();
    docker("image", "rm", IMAGE);
  }
  await processes?.stopAll();
  await rm(dir, { recursive: true, force: true });
}, 120_000);

describe.skipIf(!ready)("the task network on a real Docker daemon", () => {
  it("lets a task's containers reach each other by name, and nothing of another task, the host or the network around it", async () => {
    expect(
      (
        await run(
          A,
          "run",
          "-d",
          "--name",
          "web",
          "-p",
          "8080:8080",
          IMAGE,
          "python3",
          "-m",
          "http.server",
          "8080",
        )
      ).code,
    ).toBe(0);
    expect((await run(A, "run", "-d", "--name", "api", IMAGE, "sleep", "600")).code).toBe(0);
    expect(
      (await run(B, "run", "-d", "--name", "peer", IMAGE, "python3", "-m", "http.server", "9000")).code,
    ).toBe(0);
    await new Promise((r) => setTimeout(r, 1500));
    const api = "majhi-zzt-911-c-api";

    expect(connect(api, "web", 8080)).toBe("CONNECTED");
    expect(connect(api, "majhi-zzt-911-c-web", 8080)).toBe("CONNECTED");
    // Another task's container, by name and by every address it has.
    expect(connect(api, "peer", 9000)).toMatch(/^BLOCKED/);
    for (const address of addresses("majhi-zzt-912-h-peer")) {
      expect(connect(api, address, 9000), address).toMatch(/^BLOCKED/);
    }
    // And the other way: the other task's container cannot reach this one.
    for (const address of addresses("majhi-zzt-911-h-web")) {
      expect(connect("majhi-zzt-912-c-peer", address, 8080), address).toMatch(/^BLOCKED/);
    }
    // The computer, its gateways, private ranges and link-local addresses.
    const gateway = docker(
      "network",
      "inspect",
      "-f",
      "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
      `majhi-zzt-911`,
    ).stdout.trim();
    for (const target of [
      "host.docker.internal",
      gateway,
      "10.0.0.1",
      "172.20.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "169.254.169.254",
    ]) {
      expect(connect(api, target, 80), target).toMatch(/^BLOCKED/);
    }
    // No Docker socket, and no capability to change the rules.
    expect(docker("exec", api, "sh", "-c", "ls /var/run/docker.sock /run/docker.sock 2>&1").stdout).toContain(
      "No such file",
    );
    expect(docker("exec", api, "sh", "-c", "grep CapEff /proc/self/status").stdout.trim()).toBe(
      "CapEff:\t00000000000000cb",
    );
  }, 180_000);

  it("reaches the public internet from a container, as the agent's own container does", async () => {
    const online = spawnSync("curl", ["-sI", "--max-time", "6", "https://1.1.1.1"]).status === 0;
    if (!online) return;
    expect(connect("majhi-zzt-911-c-api", "1.1.1.1", 443)).toBe("CONNECTED");
  }, 60_000);

  it("publishes nothing on the host", () => {
    for (const container of names(A)) {
      const bindings = docker("inspect", "-f", "{{json .HostConfig.PortBindings}}", container).stdout.trim();
      expect(["null", "{}"], `${container} ${bindings}`).toContain(bindings);
    }
  });

  it("keeps a task's containers from every other task's token", async () => {
    const before = names(A);
    expect((await run(B, "ps", "-a", "--format", "{{.Names}}")).stdout.trim()).toBe("peer");
    for (const argv of [
      ["rm", "-f", "web"],
      ["rm", "-f", "majhi-zzt-911-c-web"],
      ["stop", "api"],
      ["exec", "api", "ls"],
      ["logs", "api"],
      ["inspect", "api"],
    ]) {
      await run(B, ...argv);
    }
    // An id of A's container is read as a name of B's, which finds nothing.
    for (const id of ids(A)) await run(B, "rm", "-f", id);
    expect(names(A)).toEqual(before);
  }, 120_000);

  it("runs a compose file as the same containers: by name, nothing published, nothing privileged", async () => {
    await run(A, "rm", "-f", "web", "api");
    const up = await service.taskDocker(
      A,
      { argv: ["compose", "up", "-d"], cwd: folderOf(A) },
      { ask: async () => "pending" },
    );
    expect(up.code, up.stderr).toBe(0);
    await new Promise((r) => setTimeout(r, 1500));
    expect(connect("majhi-zzt-911-c-api", "web", 8080)).toBe("CONNECTED");
    expect(names(A)).toEqual([
      "majhi-zzt-911-c-api",
      "majhi-zzt-911-c-web",
      "majhi-zzt-911-h-api",
      "majhi-zzt-911-h-web",
    ]);
    for (const container of names(A)) {
      expect(
        docker(
          "inspect",
          "-f",
          "{{.HostConfig.Privileged}} {{.HostConfig.NetworkMode}} {{json .HostConfig.PortBindings}}",
          container,
        ).stdout.trim(),
      ).toMatch(/^false (container:[0-9a-f]+|[a-z0-9-]+) (null|\{\})$/);
    }
    const down = await service.taskDocker(
      A,
      { argv: ["compose", "down"], cwd: folderOf(A) },
      { ask: async () => "pending" },
    );
    expect(down.code).toBe(0);
    expect(names(A)).toEqual([]);
  }, 240_000);

  it("closes the builder's network: RUN steps reach the public internet and nothing private", async () => {
    if (docker("buildx", "version").status !== 0 || docker("image", "inspect", "alpine:3").status !== 0)
      return;
    const gateway = docker(
      "network",
      "inspect",
      "-f",
      "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
      "bridge",
    ).stdout.trim();
    writeFileSync(
      join(folderOf(A), "Dockerfile"),
      [
        "FROM alpine:3",
        ...[
          ["PUBLIC", "http://1.1.1.1"],
          ["GATEWAY", `http://${gateway}`],
          ["HOST", "http://host.docker.internal"],
          ["METADATA", "http://169.254.169.254"],
          ["LAN", "http://192.168.1.1"],
          ["TENX", "http://10.0.0.1"],
        ].map(
          ([label, url]) =>
            `RUN wget -T3 -qO- ${url} >/dev/null 2>&1 && echo ${label}-REACHED || echo ${label}-BLOCKED`,
        ),
      ].join("\n"),
    );
    const out = await run(A, "build", "-t", "probe:1", "--no-cache", ".");
    // The probes print to the build log, which is the call's output.
    const text = `${out.stdout}${out.stderr}`;
    expect(out.code, text).toBe(0);
    expect(text).toMatch(/PUBLIC-(REACHED|BLOCKED)/);
    for (const label of ["GATEWAY", "HOST", "METADATA", "LAN", "TENX"]) {
      expect(text, label).toContain(`${label}-BLOCKED`);
    }
    // A build that pulls an image nobody allowed does not start.
    writeFileSync(join(folderOf(A), "Dockerfile"), "FROM node:22\n");
    expect((await run(A, "build", "-t", "probe:2", ".")).error?.code).toBe("image_not_allowed");
  }, 300_000);

  it("builds only what it checked: an escape directive cannot hide a FROM, BUILDKIT_SYNTAX is refused, an allowed build runs", async () => {
    if (docker("buildx", "version").status !== 0 || docker("image", "inspect", "alpine:3").status !== 0)
      return;
    const dockerfile = (text: string) => writeFileSync(join(folderOf(A), "Dockerfile"), text);
    const build = (...extra: string[]) => run(A, "build", "-t", "probe:3", ...extra, ".");
    // With `# escape=` a backslash joins nothing: BuildKit starts a second stage from node:22.
    dockerfile("# escape=`\nFROM alpine:3\nRUN echo \\\nFROM node:22\n");
    expect((await build()).error?.code).toBe("image_not_allowed");
    // A directive that is not syntax, escape or check.
    dockerfile("# foo=bar\nFROM alpine:3\n");
    expect((await build()).error?.code).toBe("refused");
    // The frontend named by a build argument is never loaded.
    dockerfile("FROM alpine:3\n");
    expect((await build("--build-arg", "BUILDKIT_SYNTAX=evil/frontend:1")).error?.code).toBe(
      "flag_not_allowed",
    );
    expect(docker("image", "inspect", "evil/frontend:1").status).not.toBe(0);
    // An allowed build still works.
    const out = await build("--no-cache");
    expect(out.code, `${out.stdout}${out.stderr}`).toBe(0);
    expect(docker("image", "inspect", "majhi-zzt-911-img-probe:3").status).toBe(0);
  }, 300_000);

  it("removes everything a task started when it ends, and everything after a restart", async () => {
    await run(A, "run", "-d", "--name", "x", IMAGE, "sleep", "600");
    await run(B, "run", "-d", "--name", "y", IMAGE, "sleep", "600");
    expect(names(A)).toEqual(["majhi-zzt-911-c-x", "majhi-zzt-911-h-x"]);
    await service.taskEnded(A);
    expect(names(A)).toEqual([]);
    expect(docker("network", "inspect", "majhi-zzt-911").status).not.toBe(0);
    expect(names(B)).toEqual(expect.arrayContaining(["majhi-zzt-912-c-y", "majhi-zzt-912-h-y"]));
    // A new server (a restart or a crash): the task's containers and network are removed, once and again.
    const restarted = make([B]);
    await restarted.startup();
    expect(names(B)).toEqual([]);
    expect(docker("network", "inspect", "majhi-zzt-912").status).not.toBe(0);
    await restarted.startup();
    expect(names(B)).toEqual([]);
  }, 180_000);
});
