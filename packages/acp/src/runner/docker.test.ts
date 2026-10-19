import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFastExecutable } from "../../testing/fastBin.ts";
import { localSpawner, type SpawnRequest } from "../spawn.ts";
import {
  dockerRunArgs,
  dockerSpawner,
  dockerTty,
  MAJHI_HOOKS_DIR,
  MAJHI_RUN_CONNECTIONS_DIR,
  MountRefused,
  orphanRuns,
  type RunnerConfig,
  removeStaleRunners,
  runMounts,
  SPAWNER_LABEL,
} from "./docker.ts";

let root: string;
let home: string;
let majhiHome: string;
let cfg: RunnerConfig;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "majhi-runner-"));
  home = join(root, "Users", "owner");
  majhiHome = join(home, ".majhi");
  await mkdir(join(majhiHome, "accounts", "claude-acme"), { recursive: true });
  await mkdir(join(majhiHome, "accounts", "claude-globex"), { recursive: true });
  await mkdir(join(home, "Work", ".majhi", "ACM-1"), { recursive: true });
  await mkdir(join(home, "Work", "api", ".git", "hooks"), { recursive: true });
  await writeFile(join(home, "Work", "api", ".git", "config"), "[core]\n");
  await mkdir(join(root, "keys"), { recursive: true });
  await writeFile(join(root, "keys", "secrets.key"), "AGE-SECRET-KEY-1TEST\n");
  cfg = {
    image: "majhi-runner:dev",
    network: "majhi-runners",
    user: "501:20",
    cliEnv: { PATH: process.env.PATH ?? "/usr/bin" },
    majhiHome,
    protectedPaths: [join(root, "keys", "secrets.key")],
  };
});
afterEach(() => rm(root, { recursive: true, force: true }));

function request(extra: Partial<SpawnRequest> = {}): SpawnRequest {
  const repo = join(home, "Work", "api", ".git");
  return {
    command: { command: "claude-agent-acp", args: [] },
    env: {
      PATH: "/usr/bin",
      HOME: join(majhiHome, "accounts", "claude-acme"),
      ANTHROPIC_API_KEY: "sk-test-value-never-in-argv",
    },
    cwd: join(home, "Work", ".majhi", "ACM-1"),
    account: { tool: "claude", home: join(majhiHome, "accounts", "claude-acme") },
    mounts: [
      { path: repo },
      { path: join(repo, "config"), readOnly: true },
      { path: join(repo, "hooks"), readOnly: true },
    ],
    ...extra,
  };
}

const mountArgs = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "--mount" ? [a] : []));

describe("runner mounts", () => {
  it("mounts only the task folder, the repo's .git (config and hooks read-only) and the run's own account home", () => {
    const args = dockerRunArgs(request(), cfg, "majhi-run-test");
    const repo = join(home, "Work", "api", ".git");
    expect(mountArgs(args)).toEqual([
      `type=bind,source=${join(home, "Work", ".majhi", "ACM-1")},target=${join(home, "Work", ".majhi", "ACM-1")}`,
      `type=bind,source=${join(majhiHome, "accounts", "claude-acme")},target=${join(majhiHome, "accounts", "claude-acme")}`,
      `type=bind,source=${repo},target=${repo}`,
      `type=bind,source=${join(repo, "config")},target=${join(repo, "config")},readonly`,
      `type=bind,source=${join(repo, "hooks")},target=${join(repo, "hooks")},readonly`,
    ]);
    const joined = args.join(" ");
    expect(joined).not.toContain("secrets.key");
    expect(joined).not.toContain("claude-globex");
    expect(joined).not.toContain("docker.sock");
    expect(mountArgs(args).some((m) => m.includes(`source=${majhiHome},`))).toBe(false);
  });
});

/** A docker CLI that keeps containers and their labels in a file: run, ps -a with label filters, rm -f. */
async function statefulDocker(): Promise<{
  cli: string;
  containers: () => Promise<Record<string, Record<string, string>>>;
  add: (name: string, labels: Record<string, string>) => Promise<void>;
}> {
  const state = join(root, "containers");
  const cli = join(root, "docker");
  await mkdir(state);
  await writeFastExecutable(
    cli,
    `#!/usr/bin/env node
const fs = require("node:fs");
const file = require("node:path").dirname(process.argv[1]) + "/containers";
const args = process.argv.slice(2);
// Each container owns one file: separate CLI processes cannot lose each other's updates.
const read = () => Object.fromEntries(fs.readdirSync(file).filter(n => !n.startsWith(".")).flatMap(name => {
  try { return [[name, JSON.parse(fs.readFileSync(file + "/" + name, "utf8"))]]; }
  catch (err) { if (err.code === "ENOENT") return []; throw err; }
}));
const write = (name, labels) => {
  const tmp = file + "/." + name + "." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(labels));
  fs.renameSync(tmp, file + "/" + name);
};
const values = (flag) => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));
if (args[0] === "run") {
  write(values("--name")[0], Object.fromEntries(values("--label").map((l) => l.split("="))));
  process.stdin.pipe(process.stdout);
} else if (args[0] === "ps") {
  const want = values("--filter").map((f) => f.slice("label=".length).split("="));
  for (const [name, labels] of Object.entries(read()))
    if (want.every(([k, v]) => labels[k] === v)) console.log(name);
} else if (args[0] === "rm") {
  for (const name of args.slice(2)) fs.rmSync(file + "/" + name, {force: true});
}
`,
  );
  const containers = async (): Promise<Record<string, Record<string, string>>> => {
    const names = (await readdir(state)).filter((name) => !name.startsWith("."));
    const entries = await Promise.all(
      names.map(async (name) => {
        const text = await readFile(join(state, name), "utf8").catch((err) => {
          if (err.code === "ENOENT") return undefined;
          throw err;
        });
        return text === undefined ? [] : [[name, JSON.parse(text) as Record<string, string>]];
      }),
    );
    return Object.fromEntries(entries.flat());
  };
  return {
    cli,
    containers,
    async add(name, labels) {
      const tmp = join(state, `.${name}.add`);
      await writeFile(tmp, JSON.stringify(labels));
      await rename(tmp, join(state, name));
    },
  };
}

/** Waits until `check` holds. It has no deadline of its own: the test's timeout is the only clock. */
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  while (!(await check())) await new Promise((r) => setTimeout(r, 10));
}
