import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Limits, type Safety, serviceRunArgs } from "./args.ts";
import { DockerCli } from "./docker.ts";

/**
 * What a service's variables reach: the docker CLI that majhi runs is started with its own small
 * environment. A container's variable, whatever its name, never joins it, and no value is on the
 * command line. Played with a stand-in for `docker` that records what it was started with.
 */

const limits: Limits = { cpus: 1, memory: "1g" };
let root: string;
let safety: Safety;
let report: string;
let cli: DockerCli;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "majhi-docker-env-"));
  const hostHome = join(root, "Users", "owner");
  const taskFolder = join(hostHome, "Work", ".majhi", "ACM-1");
  await mkdir(taskFolder, { recursive: true });
  safety = {
    task: "ACM-1",
    runnerNetwork: "majhi-runners",
    majhiHome: join(hostHome, ".majhi"),
    hostHome,
    protectedPaths: [],
    taskFolder,
  };
  report = join(root, "report");
  const fake = join(root, "docker");
  await writeFile(
    fake,
    [
      "#!/bin/sh",
      `env | sort > '${report}'`,
      `echo "ARGV $*" >> '${report}'`,
      'prev=""',
      'for a in "$@"; do',
      `  if [ "$prev" = "--env-file" ]; then echo "FILE $a" >> '${report}'; cat "$a" >> '${report}'; fi`,
      '  prev="$a"',
      "done",
      "",
    ].join("\n"),
  );
  await chmod(fake, 0o755);
  cli = new DockerCli({
    docker: fake,
    cliEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    majhiHome: safety.majhiHome,
    hostHome,
    protectedPaths: [],
  });
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("the environment of majhi's docker CLI", () => {
  it("holds nothing of a container's variables, and the values reach the container through a file that is gone after", async () => {
    const parts = serviceRunArgs(safety, limits, {
      name: "db",
      image: "postgres:16",
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example:4318",
        POSTGRES_PASSWORD: "pg-secret-1234",
        LD_PRELOAD: "/work/evil.so",
      },
    });
    const spawned = await cli.attached(parts, safety);
    await new Promise((done) => spawned.child.once("exit", done));
    const seen = await readFile(report, "utf8");
    const [environment = "", rest = ""] = seen.split("ARGV ");
    for (const name of ["OTEL_EXPORTER_OTLP_ENDPOINT", "POSTGRES_PASSWORD", "LD_PRELOAD"]) {
      expect(environment, name).not.toContain(name);
    }
    expect(environment).toContain("DOCKER_CONFIG=");
    const [argv = "", file = ""] = rest.split("FILE ");
    expect(argv).not.toContain("pg-secret-1234");
    expect(argv).not.toContain("collector.example");
    const [path = "", ...lines] = file.split("\n");
    expect(lines.sort()).toEqual([
      "",
      "LD_PRELOAD=/work/evil.so",
      "OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.example:4318",
      "POSTGRES_PASSWORD=pg-secret-1234",
    ]);
    for (let i = 0; i < 50 && existsSync(path); i++) await new Promise((done) => setTimeout(done, 20));
    expect(existsSync(path)).toBe(false);
  });
});
