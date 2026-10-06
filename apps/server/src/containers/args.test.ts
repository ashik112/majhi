import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNoHostPaths,
  assertSafe,
  buildArgs,
  builderCreateArgs,
  builderGuardRunArgs,
  ContainerRefused,
  type DockerParts,
  dockerArgv,
  hostForwardRunArgs,
  hostNetworkCreateArgs,
  type Limits,
  networkCreateArgs,
  previewHoldRunArgs,
  previewRunArgs,
  type Safety,
  serviceRunArgs,
  taskHoldRunArgs,
  takeEnv,
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
    scratch: "/preview",
    env: { MODE: "test" },
  });
const holder = (subnets: string[] = ["192.168.171.0/24"]) =>
  previewHoldRunArgs(safety, limits, { port: 7070, image: "majhi-runner:dev", taskSubnets: subnets });
const taskHolder = (name = "db", aliases: string[] = []) =>
  taskHoldRunArgs(safety, limits, {
    name,
    aliases,
    taskSubnets: ["192.168.171.0/24"],
    image: "majhi-runner:dev",
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

describe("the holder of a task's container", () => {
  const refused = (parts: DockerParts) => () => assertSafe(parts, safety);
  it("is the guarded way onto the task network: runner network for the route out, the task network under the container's names, nothing published", () => {
    const h = taskHolder("db", ["pg"]);
    expect(h.flags).toContain("--detach");
    expect(values(h, "--name")).toEqual(["majhi-acm-1-h-db"]);
    expect(values(h, "--network")).toEqual([
      "majhi-runners",
      "name=majhi-acm-1,alias=db,alias=majhi-acm-1-c-db,alias=pg",
    ]);
    expect(values(h, "--cap-add")).toEqual(["NET_ADMIN"]);
    expect(h.flags).not.toContain("--publish");
    expect(h.command).toEqual([
      "node",
      "/usr/local/lib/majhi/netguard.mjs",
      "--hold",
      "--allow",
      "192.168.171.0/24",
    ]);
  });

  it("puts the service in the holder's network namespace, so it can never run without the guard", () => {
    expect(values(service(), "--network")).toEqual(["container:majhi-acm-1-h-db"]);
    expect(values(service(), "--name")).toEqual(["majhi-acm-1-c-db"]);
    expect(values(service(), "--label")).toContain("majhi.container=taskrun");
  });

  it("is refused when widened: another network, a published port, a mount, a capability, a command or another task's names", () => {
    const h = taskHolder();
    expect(() => assertSafe(h, safety)).not.toThrow();
    for (const bad of [
      plus(h, "--publish", "127.0.0.1::80"),
      plus(h, "--mount", "type=volume,target=/x"),
      plus(h, "--cap-add", "NET_RAW"),
      plus(h, "--network", "majhi-acm-2"),
      replaced(h, "--network", "host"),
      replaced(h, "--name", "majhi-acm-2-h-db"),
      replaced(h, "--name", "majhi-acm-1-c-db"),
      without(h, "--read-only"),
      { ...h, command: ["sh", "-c", "sleep 1"] },
      { ...h, command: ["node", "/usr/local/lib/majhi/netguard.mjs", "--hold", "--allow", "10.0.0.0/8"] },
      { ...h, command: ["node", "/usr/local/lib/majhi/netguard.mjs", "--hold"] },
    ]) {
      expect(refused(bad)).toThrow(ContainerRefused);
    }
    // An alias that is not a host name, or more names than a task container needs.
    expect(() => taskHolder("db", ["Bad Name"])).toThrow(ContainerRefused);
    expect(() => taskHolder("db", ["a", "b", "c", "d", "e", "f", "g", "h"])).toThrow(ContainerRefused);
  });

  it("never answers to a name that belongs to something else: the preview, a forwarder, majhi's own, the computer", () => {
    for (const name of [
      "preview",
      "Preview",
      "localhost",
      "db.host",
      "host.docker.internal",
      "gateway.docker.internal",
      "majhi-server",
      "majhi-acm-2-c-db",
    ]) {
      for (const make of [() => taskHolder("db", [name]), () => taskHolder(name)]) {
        try {
          make();
          throw new Error(`${name} was allowed`);
        } catch (err) {
          expect(err).toBeInstanceOf(ContainerRefused);
          expect((err as ContainerRefused).refusal, name).toBe("name_reserved");
        }
      }
    }
    // The checked call itself, whoever built it: a holder with an extra reserved alias is refused.
    const good = taskHolder("db");
    expect(
      refused(replaced(good, "--network", "name=majhi-acm-1,alias=db,alias=majhi-acm-1-c-db,alias=preview")),
    ).toThrow(ContainerRefused);
    expect(
      refused(replaced(good, "--network", "name=majhi-acm-1,alias=db,alias=majhi-acm-1-c-db,alias=x.host")),
    ).toThrow(ContainerRefused);
  });

  it("is the only container that may run detached", () => {
    expect(refused(plus(service(), "--detach"))).toThrow(ContainerRefused);
    expect(refused(plus(preview(), "--detach"))).toThrow(ContainerRefused);
  });
});

describe("the guard of a task's builder", () => {
  const refused = (parts: DockerParts) => () => assertSafe(parts, safety);
  const guard = () => builderGuardRunArgs(safety, { image: "majhi-runner:dev", id: "abcd1234" });

  it("shares only the builder's network namespace, adds NET_ADMIN and runs only the network guard", () => {
    const g = guard();
    expect(values(g, "--network")).toEqual(["container:buildx_buildkit_majhi-preview-acm-10"]);
    expect(values(g, "--cap-add")).toEqual(["NET_ADMIN"]);
    for (const bad of [
      replaced(g, "--network", "container:buildx_buildkit_majhi-preview-acm-20"),
      replaced(g, "--network", "container:majhi-server"),
      replaced(g, "--network", "host"),
      plus(g, "--mount", "type=volume,target=/x"),
      plus(g, "--publish", "127.0.0.1::80"),
      plus(g, "--cap-add", "SYS_ADMIN"),
      plus(g, "--env", "A=b"),
      without(g, "--read-only"),
      replaced(g, "--name", "majhi-acm-2-bg-abcd1234"),
      { ...g, command: ["sh", "-c", "iptables -F"] },
      { ...g, command: ["node", "/usr/local/lib/majhi/netguard.mjs", "--hold"] },
    ]) {
      expect(refused(bad)).toThrow(ContainerRefused);
    }
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
    // A preview has no network of its own: only its holder's, which holds the guard.
    for (const net of [
      "host",
      "container:abc",
      "majhi-acm-2",
      "bridge",
      "majhi-runners",
      "majhi-acm-1",
      "none",
    ]) {
      expect(refused(replaced(preview(), "--network", net))).toThrow(ContainerRefused);
    }
    expect(refused(plus(preview(), "--network", "majhi-runners"))).toThrow(ContainerRefused);
    for (const net of [
      "host",
      "container:abc",
      "majhi-acm-2",
      "bridge",
      "majhi-acm-1",
      "name=majhi-acm-1,alias=db",
    ]) {
      expect(refused(replaced(holder(), "--network", net))).toThrow(ContainerRefused);
    }
    expect(refused(plus(holder(), "--network", "majhi-acm-2"))).toThrow(ContainerRefused);
  });

  it("a preview publishes nothing, and its holder publishes one loopback port", () => {
    expect(() => assertSafe(preview(), safety)).not.toThrow();
    expect(refused(plus(preview(), "--publish", "127.0.0.1::7070"))).toThrow(ContainerRefused);
    expect(() => assertSafe(holder(), safety)).not.toThrow();
    expect(values(holder(), "--network")).toEqual(["majhi-runners", "name=majhi-acm-1,alias=preview"]);
    for (const publish of ["7070:7070", "0.0.0.0::7070", "127.0.0.1:8080:7070", "127.0.0.1::70000"]) {
      expect(refused(replaced(holder(), "--publish", publish))).toThrow(ContainerRefused);
    }
  });

  it("a holder runs only the network guard, with NET_ADMIN and nothing else, and no mount, host name or environment", () => {
    const h = holder();
    expect(values(h, "--cap-add")).toEqual(["NET_ADMIN"]);
    expect(refused(plus(h, "--cap-add", "NET_RAW"))).toThrow(ContainerRefused);
    expect(refused(plus(h, "--mount", "type=volume,target=/x"))).toThrow(ContainerRefused);
    expect(refused(plus(h, "--add-host", "host.docker.internal:host-gateway"))).toThrow(ContainerRefused);
    expect(refused(plus(h, "--env", "A=b"))).toThrow(ContainerRefused);
    expect(refused(without(h, "--read-only"))).toThrow(ContainerRefused);
    for (const command of [
      ["sh", "-c", "sleep 1"],
      ["node", "/other.mjs", "--hold"],
      ["node", "/usr/local/lib/majhi/netguard.mjs"],
      ["node", "/usr/local/lib/majhi/netguard.mjs", "--hold"],
      ["node", "/usr/local/lib/majhi/netguard.mjs", "--hold", "--allow", "10.0.0.0/4"],
      ["node", "/usr/local/lib/majhi/netguard.mjs", "--hold", "--server", "majhi-server:7070"],
    ]) {
      expect(refused({ ...h, command })).toThrow(ContainerRefused);
    }
  });

  it("no other container may add NET_ADMIN", () => {
    expect(refused(plus(preview(), "--cap-add", "NET_ADMIN"))).toThrow(ContainerRefused);
    expect(refused(plus(service(), "--cap-add", "NET_ADMIN"))).toThrow(ContainerRefused);
  });

  it("a publish on all interfaces, a fixed host port, or any publish by a service", () => {
    for (const publish of [
      "7070:7070",
      "0.0.0.0::7070",
      "::7070",
      "127.0.0.1:8080:7070",
      "127.0.0.1::70000",
    ]) {
      expect(refused(replaced(holder(), "--publish", publish))).toThrow(ContainerRefused);
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

  it("refuse a build argument that BuildKit reads for itself, whatever its case", () => {
    for (const name of ["BUILDKIT_SYNTAX", "buildkit_syntax", "BUILDKIT_MULTI_PLATFORM"]) {
      expect(() =>
        buildArgs(safety, {
          context: repo,
          dockerfile: "Dockerfile",
          buildArgs: { [name]: "evil/frontend:1" },
        }),
      ).toThrow(ContainerRefused);
      expect(refusedBuild(plus(build(), "--build-arg", `${name}=evil/frontend:1`))).toThrow(ContainerRefused);
    }
    expect(
      buildArgs(safety, { context: repo, dockerfile: "Dockerfile", buildArgs: { BUILD_MODE: "x" } }).flags,
    ).toContain("BUILD_MODE=x");
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

describe("environment values stay off the command line", () => {
  it("moves a service's variables into a file and leaves no value on the line", () => {
    const parts = serviceRunArgs(safety, limits, {
      name: "db",
      image: "postgres:16",
      env: { POSTGRES_PASSWORD: "pg-secret-1234", PATH: "/custom", LD_PRELOAD: "/work/evil.so" },
    });
    const moved = takeEnv(parts);
    const line = dockerArgv(moved.parts).join(" ");
    for (const value of ["pg-secret-1234", "/custom", "/work/evil.so"]) expect(line).not.toContain(value);
    // The file docker reads holds every one, verbatim: nothing in it is a variable of the CLI's own.
    expect(moved.text.split("\n").sort()).toEqual([
      "",
      "LD_PRELOAD=/work/evil.so",
      "PATH=/custom",
      "POSTGRES_PASSWORD=pg-secret-1234",
    ]);
    // The check runs on the call as built, before the values move.
    expect(() => assertSafe(parts, safety)).not.toThrow();
  });

  it("leaves a value that a line of a file cannot hold on the command line, and changes nothing without variables", () => {
    const parts = serviceRunArgs(safety, limits, {
      name: "db",
      image: "postgres:16",
      env: { MULTI: "a\nb", PLAIN: "x" },
    });
    const moved = takeEnv(parts);
    expect(moved.text).toBe("PLAIN=x\n");
    expect(moved.parts.flags).toContain("MULTI=a\nb");
    const none = serviceRunArgs(safety, limits, { name: "db", image: "postgres:16" });
    expect(takeEnv(none)).toEqual({ parts: none, text: "" });
  });
});

describe("the forwarder of a service on the owner's computer", () => {
  const image = "majhi-runner:dev";
  const from = "192.168.171.0/24";
  const forward = () =>
    hostForwardRunArgs(safety, limits, { id: "northwind", ports: [8000, 5432], from, image });
  const pairs = (parts: DockerParts, flag: string) =>
    parts.flags.flatMap((f, i) => (parts.flags[i - 1] === flag ? [f] : []));

  it("listens on the declared ports only and joins the task's network and its own, nothing else", () => {
    const parts = forward();
    expect(parts.command).toEqual([
      "node",
      "/usr/local/lib/majhi/portforward.mjs",
      "--from",
      from,
      "8000",
      "5432",
    ]);
    expect(pairs(parts, "--network")).toEqual(["name=majhi-acm-1,alias=northwind.host", "majhi-acm-1-host"]);
    expect(pairs(parts, "--publish")).toEqual([]);
    expect(pairs(parts, "--mount")).toEqual([]);
    expect(pairs(parts, "--env")).toEqual([]);
    expect(pairs(parts, "--cap-add")).toEqual(["NET_BIND_SERVICE"]);
    expect(pairs(parts, "--add-host")).toEqual(["host.docker.internal:host-gateway"]);
    // The runner network is the one a forwarder never joins: a runner of another task could reach it there.
    expect(dockerArgv(parts)).not.toContain("majhi-runners");
  });

  it("is refused when it names majhi's own port or one that is not a port", () => {
    const named = (ports: number[], s: Safety = safety) =>
      hostForwardRunArgs(s, limits, { id: "northwind", ports, from: "192.168.171.0/24", image });
    expect(() => named([7070])).toThrow(ContainerRefused);
    expect(() => named([8000, 0])).toThrow(ContainerRefused);
    expect(() => named([65536])).toThrow(ContainerRefused);
    expect(() => named([9191], { ...safety, ownPorts: [9191] })).toThrow(ContainerRefused);
  });

  it("is refused once any flag is widened: another network, a published port, a mount or a wider command", () => {
    const base = forward();
    const tampered = (extra: string[], command = base.command): DockerParts => ({
      ...base,
      flags: [...base.flags, ...extra],
      command,
    });
    expect(() => assertSafe(base, safety)).not.toThrow();
    expect(() => assertSafe(tampered(["--network", "majhi-runners"]), safety)).toThrow(ContainerRefused);
    expect(() => assertSafe(tampered(["--publish", "127.0.0.1::8000"]), safety)).toThrow(ContainerRefused);
    expect(() => assertSafe(tampered(["--mount", "type=volume,target=/data"]), safety)).toThrow(
      ContainerRefused,
    );
    expect(() => assertSafe(tampered(["--cap-add", "NET_ADMIN"]), safety)).toThrow(ContainerRefused);
    expect(() => assertSafe(tampered(["--add-host", "db.internal:10.0.0.5"]), safety)).toThrow(
      ContainerRefused,
    );
    expect(() => assertSafe(tampered([], ["sh", "-c", "nc host.docker.internal 22"]), safety)).toThrow(
      ContainerRefused,
    );
    expect(() => assertSafe(tampered([], [...base.command, "7070"]), safety)).toThrow(ContainerRefused);
  });

  it("answers only the task's own subnet, never everyone", () => {
    const from = (cidr: string) =>
      hostForwardRunArgs(safety, limits, { id: "northwind", ports: [8000], from: cidr, image });
    expect(() => from("192.168.171.0/24")).not.toThrow();
    for (const wide of [
      "0.0.0.0/0",
      "0.0.0.0/4",
      "",
      "192.168.171.0",
      "192.168.171.0/24/1",
      "a.b.c.d/24",
      "192.168.171.256/24",
    ]) {
      expect(() => from(wide), wide).toThrow(ContainerRefused);
    }
    const base = forward();
    expect(() =>
      assertSafe({ ...base, command: base.command.filter((a) => a !== "--from") }, safety),
    ).toThrow(ContainerRefused);
  });

  it("has its own network, the one with a route out, and only a forwarder may use it", () => {
    const made = hostNetworkCreateArgs(safety);
    expect(() => assertSafe(made, safety)).not.toThrow();
    expect(() => assertSafe({ ...made, flags: ["--internal", ...made.flags] }, safety)).toThrow(
      ContainerRefused,
    );
    // Any other name still needs --internal.
    expect(() => assertSafe({ ...made, image: "majhi-elsewhere" }, safety)).toThrow(ContainerRefused);
  });
});
