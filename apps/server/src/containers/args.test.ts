import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNoHostPaths,
  assertSafe,
  buildArgs,
  builderCreateArgs,
  ContainerRefused,
  type DockerParts,
  dockerArgv,
  type Limits,
  networkCreateArgs,
  previewRunArgs,
  type Safety,
  serviceRunArgs,
  volumeCreateArgs,
} from "./args.ts";

let root: string;
let safety: Safety;
let repo: string;

const limits: Limits = { cpus: 1, memory: "2g" };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "majhi-containers-"));
  const hostHome = join(root, "Users", "owner");
  const taskFolder = join(hostHome, "Work", ".majhi", "ACM-1");
  repo = join(taskFolder, "api");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "Dockerfile"), "FROM scratch\n");
  await mkdir(join(hostHome, ".majhi", "accounts"), { recursive: true });
  await mkdir(join(hostHome, ".ssh"), { recursive: true });
  await mkdir(join(root, "keys"), { recursive: true });
  await writeFile(join(root, "keys", "secrets.key"), "AGE-SECRET-KEY-1TEST\n");
  safety = {
    task: "ACM-1",
    runnerNetwork: "majhi-runners",
    majhiHome: join(hostHome, ".majhi"),
    hostHome,
    protectedPaths: [join(root, "keys", "secrets.key")],
    taskFolder,
  };
});
afterEach(() => rm(root, { recursive: true, force: true }));

const build = () => buildArgs(safety, { context: repo, dockerfile: "Dockerfile" });
const preview = () =>
  previewRunArgs(safety, limits, {
    port: 7070,
    scratch: "/preview",
    taskNetwork: true,
    env: { MODE: "test" },
  });
const service = () =>
  serviceRunArgs(safety, limits, {
    name: "db",
    image: "postgres:16-alpine",
    env: { POSTGRES_PASSWORD: "test" },
    volumes: [{ name: "pgdata", path: "/var/lib/postgresql/data" }],
  });

/** The values that follow a flag. */
const values = (parts: DockerParts, flag: string) =>
  parts.flags.flatMap((a, i) => (parts.flags[i - 1] === flag ? [a] : []));

const plus = (parts: DockerParts, ...flags: string[]): DockerParts => ({
  ...parts,
  flags: [...parts.flags, ...flags],
});
const without = (parts: DockerParts, flag: string): DockerParts => ({
  ...parts,
  flags: parts.flags.flatMap((a, i, all) => (a === flag || all[i - 1] === flag ? [] : [a])),
});
const replaced = (parts: DockerParts, flag: string, value: string): DockerParts => ({
  ...parts,
  flags: parts.flags.map((a, i) => (parts.flags[i - 1] === flag ? value : a)),
});

describe("what majhi builds for containers", () => {
  it("never mounts anything of the host, names the socket, ~/.majhi, the key or ~/.ssh", () => {
    const calls = [
      builderCreateArgs(safety, limits),
      build(),
      preview(),
      service(),
      networkCreateArgs(safety),
      volumeCreateArgs(safety, "pgdata"),
    ];
    for (const call of calls) {
      const argv = dockerArgv(call);
      for (const arg of argv) {
        expect(arg).not.toMatch(/type=bind|^-v$|^--volume|--volumes-from|volume-opt|volume-driver|bind-/);
        expect(arg).not.toMatch(/--privileged|docker\.sock|secrets\.key/);
        expect(arg).not.toContain(safety.majhiHome);
        expect(arg).not.toContain(join(safety.hostHome, ".ssh"));
      }
    }
  });

  it("mounts only named volumes of the task, or one anonymous folder in a preview", () => {
    const mounts = values(service(), "--mount");
    expect(mounts).toEqual([`type=volume,source=majhi-acm-1-data-pgdata,target=/var/lib/postgresql/data`]);
    expect(values(preview(), "--mount")).toEqual(["type=volume,target=/preview"]);
  });

  it("puts a preview on the runner network and the task network, one port on 127.0.0.1", () => {
    const p = preview();
    expect(values(p, "--network")).toEqual(["majhi-runners", "majhi-acm-1"]);
    expect(values(p, "--publish")).toEqual(["127.0.0.1::7070"]);
    expect(p.image).toBe("majhi-preview-acm-1");
    expect(values(p, "--pull")).toEqual(["never"]);
    expect(
      values(
        previewRunArgs(safety, limits, { port: 80, scratch: "/preview", taskNetwork: false }),
        "--network",
      ),
    ).toEqual(["majhi-runners"]);
  });

  it("puts a service on the task network only, under its name, with nothing published", () => {
    const s = service();
    expect(values(s, "--network")).toEqual(["name=majhi-acm-1,alias=db"]);
    expect(s.flags).not.toContain("--publish");
    expect(values(s, "--name")).toEqual(["majhi-acm-1-db"]);
    expect(s.image).toBe("postgres:16-alpine");
  });

  it("gives every container the same caps, limits, labels and removal", () => {
    for (const c of [preview(), service()]) {
      expect(values(c, "--cap-drop")).toEqual(["ALL"]);
      expect(values(c, "--cap-add").sort()).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"]);
      expect(values(c, "--security-opt")).toEqual(["no-new-privileges"]);
      expect(values(c, "--pids-limit")).toEqual(["512"]);
      expect(values(c, "--memory")).toEqual(["2g"]);
      expect(values(c, "--cpus")).toEqual(["1"]);
      expect(c.flags).toContain("--rm");
      const labels = values(c, "--label");
      expect(labels).toContain("majhi.task=ACM-1");
      expect(labels.some((l) => l.startsWith("majhi.container="))).toBe(true);
    }
  });

  it("builds on the task's own builder, never the default one, with nothing else granted", () => {
    const b = build();
    expect(values(b, "--builder")).toEqual(["majhi-preview-acm-1"]);
    expect(values(b, "--tag")).toEqual(["majhi-preview-acm-1"]);
    expect(b.image).toBe(repo);
    for (const flag of [
      "--secret",
      "--ssh",
      "--allow",
      "--output",
      "--push",
      "--build-context",
      "--cache-to",
      "--cache-from",
      "--network",
    ]) {
      expect(b.flags).not.toContain(flag);
    }
    const created = builderCreateArgs(safety, { cpus: 2, memory: "4g" });
    expect(values(created, "--driver-opt")).toEqual([
      "memory=4g",
      "memory-swap=4g",
      "cpu-period=100000",
      "cpu-quota=200000",
    ]);
    expect(created.flags).not.toContain("--use");
  });

  it("keeps a flag-shaped value in a value position, never in a flag position", () => {
    const s = serviceRunArgs(safety, limits, {
      name: "db",
      image: "postgres:16-alpine",
      env: { A: "--privileged" },
      command: ["--privileged", "-v", "/:/host"],
    });
    expect(s.flags).toContain("A=--privileged");
    expect(s.command).toEqual(["--privileged", "-v", "/:/host"]);
  });
});

describe("assertSafe refuses", () => {
  const refused = (parts: DockerParts) => () => assertSafe(parts, safety);

  it("an image that is a flag, or anything but an image reference", () => {
    expect(refused({ ...service(), image: "--privileged" })).toThrow(ContainerRefused);
    expect(refused({ ...service(), image: "postgres --privileged" })).toThrow(ContainerRefused);
    expect(() => serviceRunArgs(safety, limits, { name: "db", image: "-v", volumes: [] })).toThrow(
      ContainerRefused,
    );
    expect(refused({ ...preview(), image: "postgres:16" })).toThrow(ContainerRefused);
  });

  it("flags that are not on the list, in any spelling", () => {
    for (const extra of [
      ["--privileged"],
      ["--device", "/dev/sda"],
      ["--pid", "host"],
      ["--ipc", "host"],
      ["--uts", "host"],
      ["--userns", "host"],
      ["--cgroupns", "host"],
      ["--volume", "/:/host"],
      ["-v", "/:/host"],
      ["--volumes-from", "other"],
      ["--mount=type=bind,source=/,target=/host"],
      ["--user", "root"],
      ["--entrypoint", "sh"],
      ["--add-host", "x:1.1.1.1"],
    ]) {
      expect(refused(plus(service(), ...extra))).toThrow(ContainerRefused);
    }
  });

  it("a bind mount, a volume outside majhi's, and driver options", () => {
    for (const mount of [
      "type=bind,source=/,target=/host",
      "type=bind,source=/tmp,target=/tmp",
      "type=tmpfs,target=/tmp",
      "type=volume,source=other,target=/data",
      "type=volume,source=majhi-other-1-data-x,target=/data",
      "type=volume,source=majhi-acm-1-data-x,target=/data,volume-opt=device=/",
      "type=volume,source=majhi-acm-1-data-x,target=/data,volume-opt=type=none",
      "type=volume,source=majhi-acm-1-data-x,target=/data,volume-driver=local",
      "type=volume,source=majhi-acm-1-data-x,target=/data,bind-propagation=shared",
      "type=volume,source=majhi-acm-1-data-x,target=/d,ata",
      "type=volume,source=majhi-acm-1-data-x,target=/../etc",
      "type=volume,target=/data",
    ]) {
      expect(refused(replaced(service(), "--mount", mount))).toThrow(ContainerRefused);
    }
    // A preview has no named volume and no other mount.
    expect(
      refused(replaced(preview(), "--mount", "type=volume,source=majhi-acm-1-data-x,target=/p")),
    ).toThrow(ContainerRefused);
    expect(refused(plus(preview(), "--mount", "type=volume,target=/second"))).toThrow(ContainerRefused);
  });

  it("the wrong network, and a host, none or container network", () => {
    for (const net of [
      "host",
      "none",
      "bridge",
      "container:abc",
      "majhi-runners",
      "name=host,alias=db",
      "name=majhi-acm-1,alias=other",
    ]) {
      expect(refused(replaced(service(), "--network", net))).toThrow(ContainerRefused);
    }
    expect(refused(plus(service(), "--network", "majhi-runners"))).toThrow(ContainerRefused);
    for (const net of ["host", "container:abc", "majhi-acm-2", "bridge"]) {
      expect(refused(replaced(preview(), "--network", net))).toThrow(ContainerRefused);
    }
    expect(refused(replaced(preview(), "--network", "majhi-acm-1"))).toThrow(ContainerRefused);
  });

  it("a publish on all interfaces, a fixed host port, or any publish by a service", () => {
    for (const publish of [
      "7070:7070",
      "0.0.0.0::7070",
      "::7070",
      "127.0.0.1:8080:7070",
      "127.0.0.1::70000",
    ]) {
      expect(refused(replaced(preview(), "--publish", publish))).toThrow(ContainerRefused);
    }
    expect(refused(plus(service(), "--publish", "127.0.0.1::5432"))).toThrow(ContainerRefused);
  });

  it("missing or widened caps, privileges and limits", () => {
    expect(refused(without(service(), "--cap-drop"))).toThrow(ContainerRefused);
    expect(refused(plus(service(), "--cap-add", "SYS_ADMIN"))).toThrow(ContainerRefused);
    expect(refused(plus(service(), "--cap-add", "ALL"))).toThrow(ContainerRefused);
    expect(refused(without(service(), "--security-opt"))).toThrow(ContainerRefused);
    expect(refused(plus(service(), "--security-opt", "seccomp=unconfined"))).toThrow(ContainerRefused);
    expect(refused(replaced(service(), "--security-opt", "apparmor=unconfined"))).toThrow(ContainerRefused);
    expect(refused(replaced(service(), "--pids-limit", "-1"))).toThrow(ContainerRefused);
    expect(refused(replaced(service(), "--pids-limit", "100000"))).toThrow(ContainerRefused);
    expect(refused(replaced(service(), "--memory", "0"))).toThrow(ContainerRefused);
    expect(refused(replaced(service(), "--cpus", "64"))).toThrow(ContainerRefused);
    expect(refused(without(service(), "--memory"))).toThrow(ContainerRefused);
    expect(refused(without(service(), "--rm"))).toThrow(ContainerRefused);
    expect(refused(without(service(), "--label"))).toThrow(ContainerRefused);
  });

  it("an environment variable passed by name, which would hand over majhi's own value", () => {
    expect(refused(replaced(service(), "--env", "POSTGRES_PASSWORD"))).toThrow(ContainerRefused);
    expect(refused(replaced(service(), "--env", "-x=1"))).toThrow(ContainerRefused);
  });

  it("the host's secrets in any argument, even after the image", () => {
    const words = [
      "/var/run/docker.sock",
      "unix:///var/run/docker.sock",
      safety.majhiHome,
      join(safety.majhiHome, "accounts"),
      join(root, "keys", "secrets.key"),
      join(safety.hostHome, ".ssh", "id_ed25519"),
    ];
    for (const word of words) {
      expect(refused({ ...service(), command: ["cat", word] })).toThrow(ContainerRefused);
      expect(refused(replaced(service(), "--env", `X=${word}`))).toThrow(ContainerRefused);
      expect(() => assertNoHostPaths(["run", word], safety)).toThrow(ContainerRefused);
    }
  });

  it("a name that is not the task's", () => {
    expect(refused(replaced(service(), "--name", "majhi-acm-2-db"))).toThrow(ContainerRefused);
    expect(refused(replaced(service(), "--name", "db"))).toThrow(ContainerRefused);
    expect(refused(replaced(preview(), "--name", "majhi-preview-acm-2"))).toThrow(ContainerRefused);
    expect(refused(replaced(service(), "--label", "majhi.task=ACM-2"))).toThrow(ContainerRefused);
  });

  it("calls that are not on the list", () => {
    expect(refused({ verb: ["exec"], flags: [], image: "x", command: ["sh"] })).toThrow(ContainerRefused);
    expect(refused({ verb: ["run"], flags: [], image: undefined, command: [] })).toThrow(ContainerRefused);
    expect(
      refused({
        verb: ["volume", "create"],
        flags: ["--opt", "device=/"],
        image: "majhi-acm-1-data-x",
        command: [],
      }),
    ).toThrow(ContainerRefused);
    expect(refused({ ...volumeCreateArgs(safety, "x"), image: "someone-elses" })).toThrow(ContainerRefused);
    expect(refused(plus(networkCreateArgs(safety), "--attachable"))).toThrow(ContainerRefused);
    expect(refused(without(networkCreateArgs(safety), "--internal"))).toThrow(ContainerRefused);
    expect(refused({ ...networkCreateArgs(safety), image: "host" })).toThrow(ContainerRefused);
  });
});

describe("builds", () => {
  const refusedBuild = (parts: DockerParts) => () => assertSafe(parts, safety);

  it("refuse secrets, ssh, entitlements, outputs, pushes and other contexts or caches", () => {
    for (const extra of [
      ["--secret", "id=k,src=/etc/passwd"],
      ["--ssh", "default"],
      ["--allow", "security.insecure"],
      ["--allow", "network.host"],
      ["--output", "type=local,dest=/tmp"],
      ["-o", "/tmp"],
      ["--push"],
      ["--build-context", "x=/"],
      ["--cache-to", "type=local,dest=/tmp"],
      ["--cache-from", "type=local,src=/tmp"],
      ["--network", "host"],
    ]) {
      expect(refusedBuild(plus(build(), ...extra))).toThrow(ContainerRefused);
    }
  });

  it("refuse the default builder, another builder or another tag", () => {
    expect(refusedBuild(without(build(), "--builder"))).toThrow(ContainerRefused);
    expect(refusedBuild(replaced(build(), "--builder", "default"))).toThrow(ContainerRefused);
    expect(refusedBuild(replaced(build(), "--builder", "majhi-preview-acm-2"))).toThrow(ContainerRefused);
    expect(refusedBuild(replaced(build(), "--tag", "majhi-preview-acm-2"))).toThrow(ContainerRefused);
    expect(refusedBuild(replaced(build(), "--tag", "registry.example.com/app:latest"))).toThrow(
      ContainerRefused,
    );
    expect(() =>
      assertSafe(replaced(builderCreateArgs(safety, limits), "--name", "default"), safety),
    ).toThrow(ContainerRefused);
    expect(() => assertSafe(plus(builderCreateArgs(safety, limits), "--use"), safety)).toThrow(
      ContainerRefused,
    );
    expect(() =>
      assertSafe(plus(builderCreateArgs(safety, limits), "--driver-opt", "network=host"), safety),
    ).toThrow(ContainerRefused);
  });

  it("refuse a build argument passed by name, and a target that is a flag", () => {
    expect(refusedBuild(plus(build(), "--build-arg", "TOKEN"))).toThrow(ContainerRefused);
    expect(() => buildArgs(safety, { context: repo, dockerfile: "Dockerfile", target: "--push" })).toThrow(
      ContainerRefused,
    );
    expect(() =>
      buildArgs(safety, { context: repo, dockerfile: "Dockerfile", buildArgs: { "A B": "x" } }),
    ).toThrow(ContainerRefused);
  });

  it("refuse a context or Dockerfile outside the task folder", () => {
    for (const context of [safety.hostHome, join(safety.hostHome, "Work"), safety.majhiHome, "/", "/etc"]) {
      expect(() => buildArgs(safety, { context, dockerfile: "Dockerfile" })).toThrow(ContainerRefused);
    }
    expect(() => buildArgs(safety, { context: repo, dockerfile: "../../../../.majhi/Dockerfile" })).toThrow(
      ContainerRefused,
    );
    expect(() => buildArgs(safety, { context: repo, dockerfile: "/etc/passwd" })).toThrow(ContainerRefused);
    expect(() => buildArgs(safety, { context: "relative/path", dockerfile: "Dockerfile" })).toThrow(
      ContainerRefused,
    );
  });

  it("refuse a context or Dockerfile that leads into ~/.majhi through a symlink", async () => {
    await writeFile(join(safety.majhiHome, "Dockerfile"), "FROM scratch\n");
    await symlink(safety.majhiHome, join(safety.taskFolder, "linked-home"));
    await symlink(join(safety.majhiHome, "Dockerfile"), join(repo, "Dockerfile.evil"));
    await symlink(join(root, "keys", "secrets.key"), join(repo, "Dockerfile.key"));
    expect(() =>
      buildArgs(safety, { context: join(safety.taskFolder, "linked-home"), dockerfile: "Dockerfile" }),
    ).toThrow(ContainerRefused);
    expect(() => buildArgs(safety, { context: repo, dockerfile: "Dockerfile.evil" })).toThrow(
      ContainerRefused,
    );
    expect(() => buildArgs(safety, { context: repo, dockerfile: "Dockerfile.key" })).toThrow(
      ContainerRefused,
    );
    // A plain subfolder of the task is fine.
    expect(buildArgs(safety, { context: repo, dockerfile: "Dockerfile" }).image).toBe(repo);
  });

  it("refuse a task folder that holds majhi's config folder", () => {
    const holding: Safety = { ...safety, taskFolder: safety.hostHome };
    expect(() => buildArgs(holding, { context: safety.hostHome, dockerfile: "Dockerfile" })).toThrow(
      ContainerRefused,
    );
  });
});
