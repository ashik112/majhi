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
 * Opt in with MAJHI_DOCKER_TESTS=1 (`pnpm test:docker`): it takes minutes and starts real containers, so the
 * default run leaves it out. Also skipped when there is no daemon or no runner image. Throwaway tasks (ZZT-911, ZZT-912) and a
 * throwaway runner network; everything is removed at the end, by label.
 */

/** The runner image holds the guard. Containers run a copy under another name: an image named `majhi-` is never allowed to a task. */
const RUNNER = "majhi-runner:dev";
const IMAGE = "zzt-probe:dev";
const A = "ZZT-911";
const B = "ZZT-912";

const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8" });
const ready = process.env.MAJHI_DOCKER_TESTS === "1" && docker("image", "inspect", RUNNER).status === 0;

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
    task: (id) =>
      ({ id, folder: folderOf(id), repos: [{ project: id.toLowerCase() }], org: "acme" }) as unknown as Task,
    openTasks: () => openTasks,
    queueWaitMs: async () => 30 * 60_000,
    allTasks: () => openTasks,
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

function sweep() {
  for (const task of [A, B]) {
    const found = ids(task);
    if (found.length > 0) docker("rm", "-f", "-v", ...found);
    const volumes = docker("volume", "ls", "-q", "--filter", `label=majhi.project=${task.toLowerCase()}`)
      .stdout.split("\n")
      .filter(Boolean);
    if (volumes.length > 0) docker("volume", "rm", "-f", ...volumes);
    docker("network", "rm", `majhi-${task.toLowerCase()}`);
  }
  docker("network", "rm", runners);
  // The workspace builder the test made: its container and state volume go with it.
  docker("rm", "-f", "-v", "buildx_buildkit_majhi-build-acme0");
  docker("volume", "rm", "-f", "buildx_buildkit_majhi-build-acme0_state");
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
});
