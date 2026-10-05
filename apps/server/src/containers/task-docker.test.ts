import { mkdtempSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Safety } from "./args.ts";
import {
  assertTaskArgv,
  ImageNotAllowed,
  type TaskDockerContext,
  translateTaskDocker,
} from "./task-docker.ts";

const dir = mkdtempSync(join(tmpdir(), "majhi-task-docker-"));
const folder = join(dir, "tasks", "ACM-1");
const safety: Safety = {
  task: "ACM-1",
  runnerNetwork: "majhi-runners",
  majhiHome: join(dir, "home", ".majhi"),
  hostHome: join(dir, "home"),
  protectedPaths: [join(dir, "keys", "secrets.key")],
  taskFolder: folder,
};

beforeAll(async () => {
  await mkdir(join(folder, "api", "deploy"), { recursive: true });
  await mkdir(join(dir, "tasks", "ACM-2", "api"), { recursive: true });
  await mkdir(join(dir, "outside"), { recursive: true });
  await symlink(join(dir, "outside"), join(folder, "api", "escape"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

function ctx(extra: Partial<TaskDockerContext> = {}): TaskDockerContext {
  return {
    safety,
    limits: { cpus: 1, memory: "512m" },
    cwd: join(folder, "api"),
    builtImages: new Set(),
    allowedImages: ["nginx:1.27-alpine"],
    ids: new Map(),
    ...extra,
  };
}

const plan = (argv: string[], extra: Partial<TaskDockerContext> = {}) =>
  translateTaskDocker(argv, ctx(extra));

describe("docker in a task: what a script may run", () => {
  it("turns a typical hand-off call into the task's own container", () => {
    const result = plan([
      "run",
      "-d",
      "--rm",
      "--name",
      "voice-nginx",
      "-v",
      "./deploy:/etc/nginx/conf.d:ro",
      "-e",
      "MODE=test",
      "nginx:1.27-alpine",
      "nginx",
      "-g",
      "daemon off;",
    ]);
    expect(result).toEqual({
      kind: "run",
      name: "majhi-acm-1-c-voice-nginx",
      detach: true,
      volumes: [],
      args: [
        "run",
        "--rm",
        "--detach",
        "--name",
        "majhi-acm-1-c-voice-nginx",
        "--label",
        "majhi.container=taskrun",
        "--label",
        "majhi.task=ACM-1",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "CHOWN",
        "--cap-add",
        "DAC_OVERRIDE",
        "--cap-add",
        "FOWNER",
        "--cap-add",
        "SETUID",
        "--cap-add",
        "SETGID",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "512",
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--network",
        "name=majhi-acm-1,alias=voice-nginx",
        "--mount",
        `type=bind,source=${join(folder, "api", "deploy")},target=/etc/nginx/conf.d,readonly`,
        "--env",
        "MODE=test",
        "nginx:1.27-alpine",
        "nginx",
        "-g",
        "daemon off;",
      ],
    });
  });

  it("uses a named volume of the task and joined short flags", () => {
    const result = plan(["run", "-it", "-vdata:/var/lib/x", "--name=db", "nginx:1.27-alpine"]);
    expect(result.kind === "run" && result.volumes).toEqual(["data"]);
    expect(result.kind === "run" && result.args).toContain(
      "type=volume,source=majhi-acm-1-data-data,target=/var/lib/x",
    );
  });

  it("builds into the task's own image name, and runs it without the owner allowing it", () => {
    const built = plan(["build", "-t", "acme/voice:test", "-f", "deploy/Dockerfile", "."]);
    expect(built.kind === "build" && built.args.slice(0, 12)).toEqual([
      "buildx",
      "build",
      "--builder",
      "majhi-preview-acm-1",
      "--load",
      "--progress",
      "plain",
      "--tag",
      "majhi-acm-1-img-acme--voice:test",
      "--file",
      join(folder, "api", "deploy", "Dockerfile"),
      "--label",
    ]);
    const run = plan(["run", "--rm", "acme/voice:test"], {
      builtImages: new Set(["majhi-acm-1-img-acme--voice:test"]),
    });
    expect(run.kind === "run" && run.args).toContain("majhi-acm-1-img-acme--voice:test");
  });

  it("asks for an image that is neither built here nor allowed", () => {
    expect(() => plan(["run", "redis:7"])).toThrow(ImageNotAllowed);
    expect(() => plan(["run", "acme/voice:test"])).toThrow(ImageNotAllowed);
  });

  it("reads own containers by the names the script gave", () => {
    expect(plan(["rm", "-f", "web"])).toEqual({ kind: "call", args: ["rm", "-f", "majhi-acm-1-c-web"] });
    expect(plan(["exec", "-i", "web", "sh", "-c", "ls"])).toEqual({
      kind: "call",
      args: ["exec", "majhi-acm-1-c-web", "sh", "-c", "ls"],
    });
    expect(plan(["logs", "--tail", "20", "web"])).toEqual({
      kind: "call",
      args: ["logs", "--tail", "20", "majhi-acm-1-c-web"],
    });
  });

  it("lists only the task's containers, whatever filter it asks", () => {
    const listed = plan(["ps", "-a", "--filter", "name=web"]);
    expect(listed).toEqual({
      kind: "call",
      args: [
        "ps",
        "-a",
        "--filter",
        "label=majhi.container=taskrun",
        "--filter",
        "label=majhi.task=ACM-1",
        "--filter",
        "name=majhi-acm-1-c-web",
      ],
    });
    expect(() => plan(["ps", "--filter", "label=majhi.task=ACM-2"])).toThrow(/not allowed/);
  });
});

describe("docker in a task: what it may never do", () => {
  const refused: [string, string[]][] = [
    ["privileged", ["run", "--privileged", "nginx:1.27-alpine"]],
    ["pid host", ["run", "--pid", "host", "nginx:1.27-alpine"]],
    ["pid host with =", ["run", "--pid=host", "nginx:1.27-alpine"]],
    ["host network", ["run", "--network", "host", "nginx:1.27-alpine"]],
    ["host network short", ["run", "--net=host", "nginx:1.27-alpine"]],
    ["ipc host", ["run", "--ipc=host", "nginx:1.27-alpine"]],
    ["added capability", ["run", "--cap-add", "SYS_ADMIN", "nginx:1.27-alpine"]],
    ["security opt", ["run", "--security-opt", "seccomp=unconfined", "nginx:1.27-alpine"]],
    ["device", ["run", "--device", "/dev/sda", "nginx:1.27-alpine"]],
    ["user", ["run", "--user", "0", "nginx:1.27-alpine"]],
    ["volumes from", ["run", "--volumes-from", "majhi-server", "nginx:1.27-alpine"]],
    ["published port", ["run", "-p", "80:80", "nginx:1.27-alpine"]],
    ["own labels", ["run", "--label", "majhi.task=ACM-2", "nginx:1.27-alpine"]],
    ["raw mount flag", ["run", "--mount", "type=bind,source=/,target=/h", "nginx:1.27-alpine"]],
    ["docker socket", ["run", "-v", "/var/run/docker.sock:/var/run/docker.sock", "nginx:1.27-alpine"]],
    ["socket under the task", ["run", "-v", `${folder}/docker.sock:/s`, "nginx:1.27-alpine"]],
    ["root of the disk", ["run", "-v", "/:/host", "nginx:1.27-alpine"]],
    ["etc", ["run", "-v", "/etc:/host", "nginx:1.27-alpine"]],
    ["majhi home", ["run", "-v", `${join(dir, "home", ".majhi")}:/m`, "nginx:1.27-alpine"]],
    ["ssh keys", ["run", "-v", `${join(dir, "home", ".ssh")}:/k`, "nginx:1.27-alpine"]],
    ["another task's folder", ["run", "-v", `${join(dir, "tasks", "ACM-2")}:/o`, "nginx:1.27-alpine"]],
    ["dotdot out of the task", ["run", "-v", "../../ACM-2:/o", "nginx:1.27-alpine"]],
    ["the tasks folder", ["run", "-v", `${join(dir, "tasks")}:/o`, "nginx:1.27-alpine"]],
    ["a symlink that leaves the task", ["run", "-v", "./escape:/o", "nginx:1.27-alpine"]],
    ["a git folder", ["run", "-v", `${folder}/api/.git:/o`, "nginx:1.27-alpine"]],
    ["a comma in the source", ["run", "-v", `${folder}/a,b:/o`, "nginx:1.27-alpine"]],
    ["a build context outside the task", ["build", "-t", "x:1", join(dir, "outside")]],
    ["a build file outside the task", ["build", "-t", "x:1", "-f", "/etc/passwd", "."]],
    ["compose", ["compose", "up"]],
    ["pull", ["network", "ls"]],
    ["volume rm", ["volume", "rm", "x"]],
    ["follow logs", ["logs", "-f", "web"]],
    ["an env file", ["run", "--env-file", "/etc/x", "nginx:1.27-alpine"]],
    ["a bare env name", ["run", "-e", "SECRET", "nginx:1.27-alpine"]],
  ];
  it.each(refused)("refuses %s", (_name, argv) => {
    expect(() => plan(argv)).toThrow();
  });

  it("reaches no container of another task, by name or by id", () => {
    // The name is always prefixed with this task's key, so a name of another task is just a name of this one.
    expect(plan(["rm", "-f", "majhi-acm-2-c-web"])).toEqual({
      kind: "call",
      args: ["rm", "-f", "majhi-acm-1-c-majhi-acm-2-c-web"],
    });
    // A name that is not a plain name cannot slip a prefix or a flag in.
    for (const bad of ["../x", "a b", "-f", "Web", "web;rm", "/etc"]) {
      expect(() => plan(["rm", bad]), bad).toThrow();
    }
    // An id of someone else's container is not in `ids` (the service lists this task's own only), so it
    // is read as a name of this task and finds nothing.
    expect(plan(["rm", "-f", "0123456789abcdef"], { ids: new Map() })).toEqual({
      kind: "call",
      args: ["rm", "-f", "majhi-acm-1-c-0123456789abcdef"],
    });
    expect(
      plan(["rm", "-f", "0123456789abcdef"], { ids: new Map([["0123456789abcdef", "majhi-acm-1-c-web"]]) }),
    ).toEqual({
      kind: "call",
      args: ["rm", "-f", "majhi-acm-1-c-web"],
    });
  });

  it("uses the limits of the settings, not the script's", () => {
    const result = plan(["run", "--memory", "64g", "--cpus", "32", "nginx:1.27-alpine"]);
    expect(result.kind === "run" && result.args).toEqual(
      expect.arrayContaining(["--memory", "512m", "--cpus", "1"]),
    );
    expect(result.kind === "run" && result.args).not.toContain("64g");
  });
});

describe("docker in a task: the allow list is checked again on the call itself", () => {
  const good = (name = "web") => {
    const result = plan(["run", "--name", name, "nginx:1.27-alpine"]);
    if (result.kind !== "run") throw new Error("not a run");
    return result.args;
  };
  const without = (args: string[], flag: string, count = 2) => {
    const at = args.indexOf(flag);
    return [...args.slice(0, at), ...args.slice(at + count)];
  };
  const allowed = ["nginx:1.27-alpine"];

  it("accepts what the translation makes", () => {
    expect(() => assertTaskArgv(good(), safety, allowed)).not.toThrow();
  });

  const bad: [string, (a: string[]) => string[]][] = [
    ["a missing cap drop", (a) => without(a, "--cap-drop")],
    ["a privileged flag", (a) => ["run", "--privileged", ...a.slice(1)]],
    ["host pid", (a) => ["run", "--pid", "host", ...a.slice(1)]],
    ["a host network", (a) => a.map((x) => (x.startsWith("name=majhi-acm-1") ? "host" : x))],
    ["another task's network", (a) => a.map((x) => x.replace("name=majhi-acm-1", "name=majhi-acm-2"))],
    ["another task's label", (a) => a.map((x) => (x === "majhi.task=ACM-1" ? "majhi.task=ACM-2" : x))],
    ["a name outside the prefix", (a) => a.map((x) => (x === "majhi-acm-1-c-web" ? "majhi-acm-2-c-web" : x))],
    ["a service's name", (a) => a.map((x) => (x === "majhi-acm-1-c-web" ? "majhi-acm-1-db" : x))],
    ["an added capability", (a) => ["run", "--cap-add", "SYS_ADMIN", ...a.slice(1)]],
    ["no memory limit", (a) => without(a, "--memory")],
    [
      "a socket mount",
      (a) => ["run", "--mount", "type=bind,source=/var/run/docker.sock,target=/s", ...a.slice(1)],
    ],
    ["a bind outside the task", (a) => ["run", "--mount", "type=bind,source=/tmp,target=/s", ...a.slice(1)]],
    [
      "a bind with an extra key",
      (a) => [
        "run",
        "--mount",
        `type=bind,source=${folder},target=/s,bind-propagation=shared`,
        ...a.slice(1),
      ],
    ],
    [
      "a volume of another task",
      (a) => ["run", "--mount", "type=volume,source=majhi-acm-2-data-x,target=/s", ...a.slice(1)],
    ],
    [
      "a volume with a driver",
      (a) => [
        "run",
        "--mount",
        "type=volume,source=majhi-acm-1-data-x,target=/s,volume-driver=x",
        ...a.slice(1),
      ],
    ],
    ["an image of another task", (a) => [...a.slice(0, -1), "majhi-acm-2-img-x:latest"]],
    ["the preview image", (a) => [...a.slice(0, -1), "majhi-preview-acm-1"]],
    ["an image the owner did not allow", (a) => [...a.slice(0, -1), "redis:7"]],
    ["a published port", (a) => ["run", "--publish", "80:80", ...a.slice(1)]],
    ["a second network", (a) => ["run", "--network", "bridge", ...a.slice(1)]],
  ];
  it.each(bad)("refuses %s", (_name, change) => {
    expect(() => assertTaskArgv(change(good()), safety, allowed)).toThrow();
  });

  it.each([
    ["rm another task's container", ["rm", "-f", "majhi-acm-2-c-web"]],
    ["rm a service of this task", ["rm", "-f", "majhi-acm-1-db"]],
    ["rm majhi's runner", ["rm", "-f", "majhi-run-aaa"]],
    ["exec in another task's container", ["exec", "majhi-acm-2-c-web", "sh"]],
    ["logs of another task's container", ["logs", "majhi-acm-2-c-web"]],
    ["inspect with a flag smuggled in", ["inspect", "--size", "majhi-acm-1-c-web"]],
    ["a ps of all tasks", ["ps", "-a"]],
    [
      "a ps of another task",
      ["ps", "--filter", "label=majhi.container=taskrun", "--filter", "label=majhi.task=ACM-2"],
    ],
    ["network connect", ["network", "connect", "majhi-acm-1", "x"]],
    ["cp out of a container", ["cp", "majhi-acm-1-c-web:/etc/passwd", "/tmp/x"]],
    [
      "a build on the default builder",
      [
        "buildx",
        "build",
        "--builder",
        "default",
        "--load",
        "--progress",
        "plain",
        "--tag",
        "majhi-acm-1-img-x:1",
        "--file",
        `${folder}/Dockerfile`,
        "--label",
        "majhi.container=image",
        "--label",
        "majhi.task=ACM-1",
        folder,
      ],
    ],
    [
      "a build tagged as another task's image",
      [
        "buildx",
        "build",
        "--builder",
        "majhi-preview-acm-1",
        "--load",
        "--progress",
        "plain",
        "--tag",
        "majhi-acm-2-img-x:1",
        "--file",
        `${folder}/Dockerfile`,
        "--label",
        "majhi.container=image",
        "--label",
        "majhi.task=ACM-1",
        folder,
      ],
    ],
  ])("refuses %s", (_name, args) => {
    expect(() => assertTaskArgv(args, safety, allowed)).toThrow();
  });
});
