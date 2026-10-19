import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
import { envRef } from "./names.ts";

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
    env: envRef("acme", "acm-1"),
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
const service = () =>
  serviceRunArgs(safety, limits, {
    name: "db",
    image: "postgres:16-alpine",
    env: { POSTGRES_PASSWORD: "test" },
    volumes: [{ name: "pgdata", path: "/var/lib/postgresql/data" }],
  });

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
    // Nothing widened gets through: caps, privileges and limits that are missing or raised are refused.
    const widened: [string, DockerParts][] = [
      ["no cap-drop", without(service(), "--cap-drop")],
      ["cap-add SYS_ADMIN", plus(service(), "--cap-add", "SYS_ADMIN")],
      ["cap-add ALL", plus(service(), "--cap-add", "ALL")],
      ["no security-opt", without(service(), "--security-opt")],
      ["seccomp unconfined", plus(service(), "--security-opt", "seccomp=unconfined")],
      ["apparmor unconfined", replaced(service(), "--security-opt", "apparmor=unconfined")],
      ["pids-limit -1", replaced(service(), "--pids-limit", "-1")],
      ["pids-limit 100000", replaced(service(), "--pids-limit", "100000")],
      ["memory 0", replaced(service(), "--memory", "0")],
      ["cpus 64", replaced(service(), "--cpus", "64")],
      ["no memory", without(service(), "--memory")],
      ["no rm", without(service(), "--rm")],
      ["no label", without(service(), "--label")],
    ];
    for (const [name, parts] of widened) {
      expect(() => assertSafe(parts, safety), name).toThrow(ContainerRefused);
    }
  });
});
