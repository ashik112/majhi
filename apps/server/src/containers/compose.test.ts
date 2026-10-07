import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContainerRefused, type Safety } from "./args.ts";
import { loadCompose } from "./compose.ts";
import { parseCompose } from "./compose-cli.ts";
import { buildRunPlan, type TaskDockerContext } from "./task-docker.ts";

/**
 * A repo's compose file is data from a repo, so it is never trusted: every key is checked against an
 * allow list, and what a service may mount or reach stops at the task folder and the task's network.
 */

const dir = mkdtempSync(join(tmpdir(), "majhi-compose-"));
const folder = join(dir, "tasks", "ACM-1");
const repo = join(folder, "shop");
const safety: Safety = {
  task: "ACM-1",
  runnerNetwork: "majhi-runners",
  majhiHome: join(dir, "home", ".majhi"),
  hostHome: join(dir, "home"),
  protectedPaths: [join(dir, "keys", "secrets.key")],
  taskFolder: folder,
};

beforeAll(() => {
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(dir, "outside"), { recursive: true });
  writeFileSync(join(dir, "outside", "secret.env"), "TOKEN=leak\n");
  symlinkSync(join(dir, "outside"), join(repo, "escape"));
  mkdirSync(join(dir, "tasks", "ACM-2"), { recursive: true });
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const ctx = (): TaskDockerContext => ({
  safety,
  limits: { cpus: 1, memory: "512m" },
  cwd: repo,
  builtImages: new Set(),
  allowedImages: ["postgres:16-alpine", "redis:7-alpine", "alpine:3"],
  ids: new Map(),
});

function only<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a service");
  return value;
}

let n = 0;
/** Writes a compose file in a fresh folder of the repo and loads it as `docker compose up` would. */
function load(yaml: string, flags: string[] = [], files: Record<string, string> = {}) {
  const sub = join(repo, `p${n++}`);
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "compose.yaml"), yaml);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(sub, name, ".."), { recursive: true });
    writeFileSync(join(sub, name), text);
  }
  const inv = parseCompose([...flags, "up", "-d"], sub);
  return loadCompose(inv, { ...ctx(), cwd: sub });
}

async function code(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ContainerRefused) return err.refusal;
    throw err;
  }
  return "accepted";
}

describe("compose: what a file may never ask for", () => {
  const service = (body: string) => `services:\n  x:\n    image: alpine:3\n${body}`;
  const refused: [string, string, string][] = [
    ["privileged", service("    privileged: true\n"), "compose_privileged"],
    ["a capability", service("    cap_add: [SYS_ADMIN]\n"), "compose_privileged"],
    ["a security option", service("    security_opt: [seccomp=unconfined]\n"), "compose_privileged"],
    ["the host pid namespace", service("    pid: host\n"), "compose_privileged"],
    ["the host network", service("    network_mode: host\n"), "compose_host_network"],
    ["another container's network", service("    network_mode: service:y\n"), "compose_host_network"],
    ["a device", service("    devices: ['/dev/sda:/dev/sda']\n"), "compose_device"],
    ["a gpu", service("    gpus: all\n"), "compose_device"],
    ["extra hosts", service("    extra_hosts: ['h:10.0.0.1']\n"), "compose_host_network"],
    [
      "the Docker socket",
      service("    volumes: ['/var/run/docker.sock:/var/run/docker.sock']\n"),
      "compose_socket_mount",
    ],
    [
      "the Docker socket in the long form",
      service("    volumes:\n      - {type: bind, source: /var/run/docker.sock, target: /s}\n"),
      "compose_socket_mount",
    ],
    ["the root of the disk", service("    volumes: ['/:/host']\n"), "compose_mount_outside"],
    ["a folder of the computer", service("    volumes: ['/etc:/host:ro']\n"), "compose_mount_outside"],
    ["the home folder", service("    volumes: ['~/.ssh:/k']\n"), "compose_mount_outside"],
    ["a folder above the task", service("    volumes: ['../../..:/o']\n"), "compose_mount_outside"],
    [
      "another task's folder",
      service(`    volumes: ['${join(dir, "tasks", "ACM-2")}:/o']\n`),
      "compose_mount_outside",
    ],
    ["a symlink that leaves the task", service("    volumes: ['../escape:/o']\n"), "compose_mount_outside"],
    [
      "a build context outside the task",
      `services:\n  x:\n    build: ${join(dir, "outside")}\n`,
      "compose_build_outside",
    ],
    [
      "a Dockerfile outside the task",
      "services:\n  x:\n    build:\n      context: .\n      dockerfile: ../../../../outside/Dockerfile\n",
      "compose_build_outside",
    ],
    [
      "an env file outside the task",
      service(`    env_file: ${join(dir, "outside", "secret.env")}\n`),
      "compose_env_file_outside",
    ],
    [
      "an env file through a symlink",
      service("    env_file: ../escape/secret.env\n"),
      "compose_env_file_outside",
    ],
    ["secrets", service("    secrets: [s]\n"), "compose_unsupported_key"],
    [
      "a key majhi does not know",
      service("    runtime: nvidia\n    something_new: 1\n"),
      "compose_unsupported_key",
    ],
    [
      "a volume driver that binds a folder",
      "services:\n  x:\n    image: alpine:3\n    volumes: ['d:/d']\nvolumes:\n  d:\n    driver_opts: {type: none, o: bind, device: /etc}\n",
      "compose_mount_outside",
    ],
    ["a volume that is not declared", service("    volumes: ['data:/d']\n"), "compose_invalid"],
    ["a service with neither image nor build", "services:\n  x:\n    command: ls\n", "compose_invalid"],
    [
      "a loop of depends_on",
      "services:\n  a:\n    image: alpine:3\n    depends_on: [b]\n  b:\n    image: alpine:3\n    depends_on: [a]\n",
      "compose_invalid",
    ],
    [
      "a depends_on on a service that is not there",
      "services:\n  a:\n    image: alpine:3\n    depends_on: [ghost]\n",
      "compose_invalid",
    ],
    [
      "a variable that is required and missing",
      service("    command: $" + "{NEED:?set it}\n"),
      "compose_invalid",
    ],
    [
      "top-level secrets",
      "services:\n  x:\n    image: alpine:3\nsecrets:\n  s: {file: /etc/passwd}\n",
      "compose_unsupported_key",
    ],
    [
      "an include of another file",
      "include: [../../outside/x.yaml]\nservices:\n  x:\n    image: alpine:3\n",
      "compose_unsupported_key",
    ],
  ];
  it.each(refused)("refuses %s", async (_name, yaml, expected) => {
    expect(await code(() => load(yaml))).toBe(expected);
  });

  it.each([
    ["a service named preview", "services:\n  preview:\n    image: alpine:3\n"],
    ["a service named localhost", "services:\n  localhost:\n    image: alpine:3\n"],
    ["a service named like majhi's", "services:\n  majhi-server:\n    image: alpine:3\n"],
    ["a service named like a forwarder", "services:\n  db.host:\n    image: alpine:3\n"],
    [
      "a container_name of the preview",
      "services:\n  x:\n    image: alpine:3\n    container_name: preview\n",
    ],
    [
      "a network alias of the computer",
      "services:\n  x:\n    image: alpine:3\n    networks:\n      default:\n        aliases: [host.docker.internal]\n",
    ],
  ])("refuses %s with name_reserved", async (_name, yaml) => {
    const project = await load(yaml);
    const planned = () => {
      for (const s of project.services) buildRunPlan(s.spec, ctx());
    };
    expect(await code(planned)).toBe("name_reserved");
  });

  it("refuses an --env-file and a -f file outside the task folder", async () => {
    const sub = join(repo, "flags");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "compose.yaml"), "services:\n  x:\n    image: alpine:3\n");
    const env = parseCompose(["--env-file", join(dir, "outside", "secret.env"), "up"], sub);
    expect(await code(() => loadCompose(env, { ...ctx(), cwd: sub }))).toBe("compose_env_file_outside");
    const file = parseCompose(["-f", join(dir, "outside", "x.yaml"), "up"], sub);
    expect(await code(() => loadCompose(file, { ...ctx(), cwd: sub }))).toBe("compose_mount_outside");
  });

  it("never waits on a compose file, .env or env_file that is a FIFO, and reads no file that is not a regular file", async () => {
    const sub = join(repo, "fifo");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "compose.yaml"), "services:\n  x:\n    image: alpine:3\n    env_file: .env\n");
    execFileSync("mkfifo", [join(sub, ".env")]);
    const started = Date.now();
    const inv = parseCompose(["up"], sub);
    await expect(loadCompose(inv, { ...ctx(), cwd: sub })).rejects.toThrow(/not a regular file/);
    // The compose file itself as a FIFO.
    const other = join(repo, "fifo2");
    mkdirSync(other, { recursive: true });
    execFileSync("mkfifo", [join(other, "compose.yaml")]);
    await expect(loadCompose(parseCompose(["up"], other), { ...ctx(), cwd: other })).rejects.toThrow(
      /not a regular file/,
    );
    // A directory where a file is expected, and a file over the cap.
    mkdirSync(join(repo, "fifo3", "compose.yaml"), { recursive: true });
    await expect(
      loadCompose(parseCompose(["up"], join(repo, "fifo3")), { ...ctx(), cwd: join(repo, "fifo3") }),
    ).rejects.toThrow(/not a regular file/);
    writeFileSync(join(repo, "big.yaml"), `x: "${"a".repeat(600 * 1024)}"\n`);
    await expect(
      loadCompose(parseCompose(["-f", "big.yaml", "up"], repo), { ...ctx(), cwd: repo }),
    ).rejects.toThrow(/too big/);
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 15_000);

  it("does not read a compose file above the task folder", async () => {
    const stray = parseCompose(["up"], dir);
    expect(await code(() => loadCompose(stray, { ...ctx(), cwd: dir }))).toBe("compose_file_not_found");
  });

  it("refuses flags that would stream or reach past the file, with a code a script can read", async () => {
    for (const argv of [
      ["up", "--abort-on-container-exit"],
      ["logs", "-f"],
      ["--context", "x", "up"],
      ["run", "x"],
      ["-f", "-", "up"],
    ]) {
      expect(await code(() => parseCompose(argv, repo)), argv.join(" ")).toMatch(
        /^(compose_unsupported_flag|command_not_available)$/,
      );
    }
  });
});

describe("compose: what a file becomes", () => {
  it("publishes nothing: a service is reached by name inside the task", async () => {
    const project = await load(
      `services:
  web:
    image: alpine:3
    ports: ["8080:80", "127.0.0.1:5432:5432/tcp", "9000"]
`,
    );
    const web = project.services[0];
    expect(web?.ports).toEqual(["80", "5432", "9000"]);
    const plan = buildRunPlan(only(web).spec, ctx());
    expect(plan.args).not.toContain("--publish");
    expect(plan.args).not.toContain("-p");
    expect(plan.args).toContain("container:majhi-acm-1-h-web");
    expect(plan.holder).toEqual({ name: "web", aliases: ["web", "majhi-acm-1-c-web"] });
    expect(plan.args).toEqual(expect.arrayContaining(["--label", "majhi.compose=web", "--cap-drop", "ALL"]));
  });

  it("keeps binds inside the task folder and turns named volumes into the task's own", async () => {
    const project = await load(
      `services:
  db:
    image: postgres:16-alpine
    volumes:
      - pg_data:/var/lib/postgresql/data
      - ./init:/docker-entrypoint-initdb.d:ro
volumes:
  pg_data:
`,
    );
    const plan = buildRunPlan(only(project.services[0]).spec, ctx());
    const mounts = plan.args.flatMap((a, i) => (plan.args[i - 1] === "--mount" ? [a] : []));
    expect(mounts).toEqual([
      "type=volume,source=majhi-acm-1-data-pg-data,target=/var/lib/postgresql/data",
      expect.stringMatching(
        /^type=bind,source=.*\/p\d+\/init,target=\/docker-entrypoint-initdb\.d,readonly$/,
      ),
    ]);
    expect(plan.volumes).toEqual(["pg-data"]);
    expect(project.volumes).toEqual(["pg-data"]);
  });

  it("starts what a service depends on first, and waits on the condition it names", async () => {
    const project = await load(
      `services:
  app:
    image: alpine:3
    depends_on:
      db: {condition: service_healthy}
      migrate: {condition: service_completed_successfully}
  migrate:
    image: alpine:3
    depends_on: [db]
  db:
    image: postgres:16-alpine
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
      interval: 1m30s
      retries: 5
`,
    );
    expect(project.services.map((s) => s.name)).toEqual(["db", "migrate", "app"]);
    expect(project.services[2]?.dependsOn).toEqual([
      { service: "db", condition: "healthy" },
      { service: "migrate", condition: "completed" },
    ]);
    expect(project.services[0]?.spec.health).toEqual({
      cmd: "'pg_isready' '-U' 'postgres'",
      interval: "90s",
      timeout: undefined,
      startPeriod: undefined,
      retries: "5",
    });
  });

  it("reads variables from the project's .env only, never from an environment", async () => {
    process.env.COMPOSE_TEST_LEAK = "from-majhi";
    try {
      const project = await load(
        `services:
  x:
    image: \${IMG:-alpine:3}
    environment:
      A: \${A}
      B: \${B:-fallback}
      LEAK: "\${COMPOSE_TEST_LEAK}"
      DOLLAR: "$$HOME"
`,
        [],
        { ".env": "A=one\n" },
      );
      expect(project.services[0]?.spec.env).toEqual(["A=one", "B=fallback", "LEAK=", "DOLLAR=$HOME"]);
    } finally {
      delete process.env.COMPOSE_TEST_LEAK;
    }
  });
});
