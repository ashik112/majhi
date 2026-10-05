import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { killTree } from "../exec.ts";
import {
  type RunMount,
  SKILLS_OVERLAY_DIR,
  type Spawned,
  type Spawner,
  type SpawnRequest,
} from "../spawn.ts";

/**
 * Runner isolation (SPEC 4.2, 6, Phase 2c). Each agent session runs in its own container from the
 * runner image, which mounts only the task folder, the task repos' `.git` folders and the
 * account's own config home, at the same absolute paths as on the host. majhi's config folder,
 * the secrets key, other accounts' homes and the Docker socket are never mounted. Secrets reach
 * the run only through its environment, passed by name so they never show in a process list.
 */
export interface RunnerConfig {
  /** The runner image, like `majhi-runner:dev`. */
  image: string;
  /** The Docker network runners join. From it, majhi answers only `/mcp`. */
  network: string;
  /** `uid:gid` the agent runs as: the owner's, so files it writes belong to them. */
  user?: string | undefined;
  /** Memory cap per run, like `4g`. */
  memory?: string | undefined;
  /** CPU cap per run, like `2`: one heavy run (a whole test suite) must not take the machine. */
  cpus?: string | undefined;
  /** Process cap per run. */
  pidsLimit?: number | undefined;
  /** The docker CLI. Default `docker`. */
  docker?: string | undefined;
  /** Environment of the docker CLI itself (PATH, DOCKER_HOST). Never reaches the agent. */
  cliEnv: Record<string, string>;
  /** majhi's config folder. Never mounted; inside it only the run's own account home is. */
  majhiHome: string;
  /** Never mounted, and no folder that holds them: the secrets key file, for one. */
  protectedPaths: string[];
  /**
   * Called before each start. Rejects when majhi cannot yet tell runner requests from the
   * owner's, so no runner starts that could reach majhi's API.
   */
  ready?: (() => Promise<void>) | undefined;
  /**
   * Extra networks a run of this task joins when it starts, like the one its service containers
   * run on. Needs Docker Engine 25 (API 1.44), which accepts `--network` more than once.
   */
  taskNetworks?: ((task: string) => string[]) | undefined;
}

/** Folders that no run may see, whatever the config says. */
const ALWAYS_PROTECTED = [
  "/var/run/docker.sock",
  "/run/docker.sock",
  "/run/secrets",
  "/proc",
  "/sys",
  "/dev",
  "/etc",
];

export class MountRefused extends Error {}

/**
 * majhi's own git hooks, under its config folder (`<majhiHome>/git-hooks`). They hold only majhi's
 * scripts, no secret, so a run may mount exactly this folder, and only read-only.
 */
export const MAJHI_HOOKS_DIR = "git-hooks";

/**
 * A run's connection files (SPEC 5.14), one folder per run under `<majhiHome>/run/connections`. A run
 * may mount a folder right under it, and only read-only: the server passes only the run's own.
 */
export const MAJHI_RUN_CONNECTIONS_DIR = "run/connections";

/** Each connection's own files, `<majhiHome>/connections/<id>`. Only a browser's `profile` folder is ever mounted. */
const CONNECTIONS_DIR = "connections";

/** Package stores, `<majhiHome>/cache/<org>`. A run mounts only its own workspace's folder, never `cache` itself. */
export const MAJHI_CACHE_DIR = "cache";
const CACHE_ORG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Command-line tools agents install, `<majhiHome>/tools/<org>`. Same rule as the package store. */
export const MAJHI_TOOLS_DIR = "tools";

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** The path and, when it exists, where its symlinks lead: both must pass. */
function realForms(path: string): string[] {
  const forms = [resolve(path)];
  try {
    const real = realpathSync(path);
    if (real !== forms[0]) forms.push(real);
  } catch {
    // Missing: Docker would create an empty folder, which exposes nothing.
  }
  return forms;
}

/**
 * The mounts of one run, checked. Throws `MountRefused` when any would expose majhi's config
 * folder (other than the run's own account home and, read-only, majhi's git hooks), a protected
 * path, or a folder holding one.
 */
export function runMounts(req: SpawnRequest, cfg: RunnerConfig): RunMount[] {
  const mounts: RunMount[] = [];
  if (!req.scratch) mounts.push({ path: req.cwd });
  if (req.account !== undefined) mounts.push({ path: req.account.home });
  for (const m of req.mounts ?? []) mounts.push(m);

  // Protected paths in both forms too: a symlink into the config folder resolves to its real path,
  // which only matches when the config folder's own path is resolved the same way.
  const majhiHomes = realForms(cfg.majhiHome);
  const accountsDirs = majhiHomes.map((h) => resolve(h, "accounts"));
  const ownHomes = req.account === undefined ? [] : realForms(req.account.home);
  const protectedPaths = [...majhiHomes, ...cfg.protectedPaths.flatMap(realForms), ...ALWAYS_PROTECTED];

  const isOwnHome = (path: string) => ownHomes.includes(path) && accountsDirs.includes(dirname(path));
  const hooksDirs = majhiHomes.map((h) => resolve(h, MAJHI_HOOKS_DIR));
  const isHooks = (path: string, m: RunMount) => m.readOnly === true && hooksDirs.includes(path);
  const runFolders = majhiHomes.map((h) => resolve(h, MAJHI_RUN_CONNECTIONS_DIR));
  const isRunFolder = (path: string, m: RunMount) =>
    m.readOnly === true && runFolders.includes(dirname(path));
  // A browser connection's profile, read-write: its logins persist, and nothing else of the connection shows.
  const connectionDirs = majhiHomes.map((h) => resolve(h, CONNECTIONS_DIR));
  const isProfile = (path: string) =>
    basename(path) === "profile" && connectionDirs.includes(dirname(dirname(path)));
  // One workspace's package store, read-write: a folder right under `cache`, nothing above or beside it.
  const cacheDirs = majhiHomes.map((h) => resolve(h, MAJHI_CACHE_DIR));
  const isCache = (path: string, m: RunMount) =>
    m.readOnly !== true && cacheDirs.includes(dirname(path)) && CACHE_ORG.test(basename(path));
  const toolsDirs = majhiHomes.map((h) => resolve(h, MAJHI_TOOLS_DIR));
  const isTools = (path: string, m: RunMount) =>
    m.readOnly !== true && toolsDirs.includes(dirname(path)) && CACHE_ORG.test(basename(path));
  for (const m of mounts) {
    if (!isAbsolute(m.path)) throw new MountRefused(`A run can only mount absolute paths, not ${m.path}.`);
    if (
      m.target !== undefined &&
      (m.readOnly !== true || resolve(m.target) !== resolve(req.cwd, SKILLS_OVERLAY_DIR))
    ) {
      throw new MountRefused(
        `A run can only show a read-only mount at ${SKILLS_OVERLAY_DIR} of its folder, not ${m.target}.`,
      );
    }
    for (const path of realForms(m.path)) {
      if (path === "/") throw new MountRefused("A run cannot mount the whole disk.");
      for (const p of protectedPaths) {
        if (inside(p, path)) throw new MountRefused(`A run cannot mount ${path}: it holds ${p}.`);
        const allowed =
          isOwnHome(path) ||
          isHooks(path, m) ||
          isRunFolder(path, m) ||
          isProfile(path) ||
          isCache(path, m) ||
          isTools(path, m);
        if (inside(path, p) && !(majhiHomes.includes(p) && allowed)) {
          throw new MountRefused(`A run cannot mount ${path}: it is inside ${p}.`);
        }
      }
    }
  }
  // Same path twice (a repo inside the task folder) is one mount.
  const seen = new Set<string>();
  return mounts.filter((m) => {
    const key = `${resolve(m.path)}:${m.readOnly === true}:${m.target ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Variables the docker CLI reads for itself. A run's own values for them are passed by value. */
const CLI_OWNED = new Set([
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
]);

/** The `docker run` arguments for one run. Environment values are passed by name only. */
export function dockerRunArgs(
  req: SpawnRequest,
  cfg: RunnerConfig,
  name: string,
  options: { tty?: boolean; spawner?: string } = {},
): string[] {
  const args = [
    "run",
    options.tty === true ? "-it" : "-i",
    "--rm",
    "--init",
    "--name",
    name,
    "--label",
    "majhi.runner=1",
    ...(options.spawner === undefined ? [] : ["--label", `${SPAWNER_LABEL}=${options.spawner}`]),
    ...(req.task === undefined ? [] : ["--label", `majhi.task=${req.task}`]),
    "--network",
    cfg.network,
    ...(req.task === undefined ? [] : (cfg.taskNetworks?.(req.task) ?? []).flatMap((n) => ["--network", n])),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(cfg.pidsLimit ?? 2048),
    "--memory",
    req.limits?.memory ?? cfg.memory ?? "4g",
    "--cpus",
    req.limits?.cpus ?? cfg.cpus ?? "1",
    // A lower weight than the default 1024 when the machine is busy (hand-off checks).
    ...(req.limits?.cpuShares === undefined ? [] : ["--cpu-shares", req.limits.cpuShares]),
  ];
  if (cfg.user) args.push("--user", cfg.user);
  args.push("--workdir", req.scratch ? "/tmp" : req.cwd);
  for (const m of runMounts(req, cfg)) {
    const p = resolve(m.path);
    const target = m.target === undefined ? p : resolve(m.target);
    args.push("--mount", `type=bind,source=${p},target=${target}${m.readOnly ? ",readonly" : ""}`);
  }
  for (const key of Object.keys(req.env).sort()) {
    // The CLI needs its own PATH and HOME, so these go by value. They are never secrets.
    args.push("--env", CLI_OWNED.has(key) ? `${key}=${req.env[key]}` : key);
  }
  args.push(cfg.image, req.command.command, ...req.command.args);
  return args;
}

/** The run's variables the CLI passes on by name. */
function secretValues(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !CLI_OWNED.has(key)));
}

/** Labels each runner container with the spawner that started it, so a prune never touches another majhi's. */
export const SPAWNER_LABEL = "majhi.spawner";

/** The environment of the docker CLI: the CLI's own, with a config folder it can write. */
function cliEnvOf(cfg: Pick<RunnerConfig, "cliEnv">): Record<string, string> {
  return { ...cfg.cliEnv, DOCKER_CONFIG: cfg.cliEnv.DOCKER_CONFIG ?? "/tmp/majhi-docker" };
}

/** `docker rm -f`, quietly: the container may be gone already. */
function removeContainers(cfg: Pick<RunnerConfig, "docker" | "cliEnv">, names: string[]): Promise<void> {
  return new Promise((done) => {
    if (names.length === 0) return done();
    const rm = spawn(cfg.docker ?? "docker", ["rm", "-f", ...names], { env: cliEnvOf(cfg), stdio: "ignore" });
    rm.on("error", () => done());
    rm.on("close", () => done());
  });
}

/** Names of runner containers, running or not, with every label in `labels`. */
function listRunners(cfg: Pick<RunnerConfig, "docker" | "cliEnv">, labels: string[]): Promise<string[]> {
  return new Promise((done) => {
    const filters = ["majhi.runner=1", ...labels].flatMap((l) => ["--filter", `label=${l}`]);
    const ps = spawn(cfg.docker ?? "docker", ["ps", "-a", ...filters, "--format", "{{.Names}}"], {
      env: cliEnvOf(cfg),
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    ps.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    ps.on("error", () => done([]));
    ps.on("close", () => done(out.split(/\s+/).filter(Boolean)));
  });
}

/** A spawner of runner containers that knows which of them still belong to a live run. */
export interface RunnerSpawner extends Spawner {
  /** Containers of runs that are still live. */
  live(): string[];
  /**
   * Removes this spawner's containers that no live run holds: one whose `docker run` CLI died,
   * or that the daemon created after a kill. Returns their names.
   */
  prune(): Promise<string[]>;
}

/**
 * Starts each run in its own runner container, and removes the container when the run is killed
 * or its docker CLI exits, so no container outlives its run.
 */
export function dockerSpawner(cfg: RunnerConfig): RunnerSpawner {
  const id = randomBytes(6).toString("hex");
  const live = new Set<string>();
  const spawner = async (req: SpawnRequest): Promise<Spawned> => {
    await cfg.ready?.();
    const name = `majhi-run-${randomBytes(6).toString("hex")}`;
    const args = dockerRunArgs(req, cfg, name, { spawner: id });
    live.add(name);
    // The CLI reads the values of `--env NAME` from its own environment.
    const child = spawn(cfg.docker ?? "docker", args, {
      env: { ...secretValues(req.env), ...cliEnvOf(cfg) },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let removed = false;
    const remove = () => {
      live.delete(name);
      if (removed) return;
      removed = true;
      // Killing the CLI does not stop the container; removing it does.
      void removeContainers(cfg, [name]);
    };
    // The CLI died (a crash, a lost daemon connection): the container may still run.
    child.once("close", remove);
    child.once("error", remove);
    return {
      child,
      cwd: req.scratch ? "/tmp" : req.cwd,
      kill() {
        killTree(child);
        remove();
      },
    };
  };
  return Object.assign(spawner, {
    live: () => [...live],
    async prune(): Promise<string[]> {
      const stale = (await listRunners(cfg, [`${SPAWNER_LABEL}=${id}`])).filter((n) => !live.has(n));
      await removeContainers(cfg, stale);
      return stale;
    },
  });
}

/** A shell for a person in a runner container: the command for a pty, and how to stop it. */
export interface TtyLaunch {
  command: string;
  args: string[];
  /** The environment of the docker CLI in the pty. The container's own comes from the arguments. */
  env: Record<string, string>;
  /** Removes the container. Killing the CLI does not stop it. Safe to call twice. */
  stop(): void;
}

/**
 * How a terminal starts in a runner container: the same image, network, user, limits and mount
 * rules as a run, with a tty. `req.account` is normally absent, so no account home is mounted.
 */
export function dockerTty(cfg: RunnerConfig): (req: SpawnRequest) => Promise<TtyLaunch> {
  const docker = cfg.docker ?? "docker";
  return async (req) => {
    await cfg.ready?.();
    const name = `majhi-term-${randomBytes(6).toString("hex")}`;
    let removed = false;
    return {
      command: docker,
      args: dockerRunArgs(req, cfg, name, { tty: true }),
      env: { ...secretValues(req.env), ...cliEnvOf(cfg) },
      stop() {
        if (removed) return;
        removed = true;
        void removeContainers(cfg, [name]);
      },
    };
  };
}

/**
 * Removes runner containers a previous majhi left behind (a crash, a restart). At start majhi
 * runs nothing yet, so every runner container is stale.
 */
export async function removeStaleRunners(cfg: Pick<RunnerConfig, "docker" | "cliEnv">): Promise<void> {
  await removeContainers(cfg, await listRunners(cfg, []));
}
