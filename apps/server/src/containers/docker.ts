import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { exec, killTree, type Spawned } from "@majhi/acp";
import { errorMessage } from "../errors.ts";
import {
  assertNoHostPaths,
  assertSafe,
  ContainerRefused,
  type DockerParts,
  dockerArgv,
  type HostPaths,
  type Safety,
} from "./args.ts";

/** A short call, like `docker ps`, waits this long at most. */
const EXEC_TIMEOUT_MS = 30_000;

/** Names majhi removes or connects by name: its own containers, networks, volumes, builders and images. */
const OWN_NAME = /^majhi-[a-z0-9][a-z0-9-]*$/;

export interface DockerCliOptions extends HostPaths {
  /** The docker CLI. Default `docker`. */
  docker?: string | undefined;
  /** PATH and DOCKER_HOST, from `env.runner.cliEnv`. Never the agent's environment. */
  cliEnv: Record<string, string>;
}

/** The result of a short call. */
export interface DockerResult {
  stdout: string;
  stderr: string;
}

const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
/** The network of a task, like `majhi-prv-53`. Not the runner network, not a preview. */
const TASK_NETWORK = /^majhi-[a-z][a-z0-9]{0,9}-[1-9][0-9]*$/;

/** Calls that only read. */
const READ_VERBS = new Set([
  "ps",
  "port",
  "inspect",
  "image inspect",
  "image ls",
  "volume inspect",
  "volume ls",
  "network inspect",
  "network ls",
  "buildx inspect",
  "buildx ls",
]);
/** Calls that remove what majhi made: only `majhi-` names and container ids, and these flags. */
const REMOVE_VERBS = new Set([
  "rm",
  "image rm",
  "volume rm",
  "network rm",
  "network disconnect",
  "buildx rm",
  "buildx stop",
]);
const REMOVE_FLAGS = new Set(["-f", "--force", "-v"]);

function verbOf(args: readonly string[]): string {
  const first = args[0] ?? "";
  return ["ps", "port", "inspect", "rm"].includes(first) ? first : `${first} ${args[1] ?? ""}`.trim();
}

/** Throws unless the call only reads, or only removes what majhi made. Creating goes through `create` and `attached`. */
function assertReadOrRemove(args: readonly string[]): void {
  const verb = verbOf(args);
  if (READ_VERBS.has(verb)) return;
  if (!REMOVE_VERBS.has(verb)) throw new ContainerRefused(`The docker command ${verb} is not allowed.`);
  const rest = args.slice(verb.split(" ").length);
  for (const arg of rest) {
    if (arg.startsWith("-")) {
      if (!REMOVE_FLAGS.has(arg)) throw new ContainerRefused(`The docker flag ${arg} is not allowed.`);
    } else if (!OWN_NAME.test(arg) && !CONTAINER_ID.test(arg)) {
      throw new ContainerRefused(`${arg} is not something of majhi's to remove.`);
    }
  }
}

/**
 * The docker CLI as majhi's server uses it for agents' containers. The environment is the CLI's own
 * (`cliEnv`) plus a config folder in `<majhiHome>/cache/docker`, where buildx keeps the metadata of the
 * task builders across restarts. Every argument of every call is scanned for host paths that no
 * container may see. Three doors, so no caller can send a call nobody checked:
 * - `exec`: reads and removals of `majhi-` things only.
 * - `connect`: a container to a task's own network.
 * - `create` and `attached`: take `DockerParts` and run `assertSafe` themselves.
 */
export class DockerCli {
  private readonly docker: string;
  private readonly env: Record<string, string>;
  private readonly configDir: string;
  /** Removals in flight by container name: a new start with the same name waits for its removal. */
  private readonly removals = new Map<string, Promise<void>>();

  constructor(private readonly options: DockerCliOptions) {
    this.docker = options.docker ?? "docker";
    this.configDir = join(options.majhiHome, "cache", "docker");
    this.env = { ...options.cliEnv, DOCKER_CONFIG: this.configDir };
  }

  /** A read (`ps`, `inspect`, `port`, `ls`) or a removal of majhi's own things. */
  exec(args: readonly string[], options: { timeoutMs?: number } = {}): Promise<DockerResult> {
    assertReadOrRemove(args);
    return this.raw(args, options.timeoutMs);
  }

  /** Puts a container on the network of its task. Nothing else can be connected. */
  connect(network: string, container: string): Promise<DockerResult> {
    if (!TASK_NETWORK.test(network)) throw new ContainerRefused(`${network} is not the network of a task.`);
    if (!OWN_NAME.test(container) && !CONTAINER_ID.test(container)) {
      throw new ContainerRefused(`${container} cannot be connected.`);
    }
    return this.raw(["network", "connect", network, container]);
  }

  /** Makes a builder, a network or a volume, after `assertSafe`. */
  create(parts: DockerParts, safety: Safety, options: { timeoutMs?: number } = {}): Promise<DockerResult> {
    if (!["buildx create", "network create", "volume create"].includes(parts.verb.join(" "))) {
      throw new ContainerRefused(`${parts.verb.join(" ")} is not a create call.`);
    }
    assertSafe(parts, safety);
    return this.raw(dockerArgv(parts), options.timeoutMs);
  }

  /**
   * Starts a `docker run` or `docker buildx build` that runs attached (no `-d`): its output is the
   * process's output. `kill()` stops the CLI and removes the container of a run (a build has none),
   * and a new start with the same name waits for that removal.
   */
  async attached(parts: DockerParts, safety: Safety, options: { cwd?: string } = {}): Promise<Spawned> {
    const verb = parts.verb.join(" ");
    if (verb !== "run" && verb !== "buildx build") throw new ContainerRefused(`${verb} cannot run attached.`);
    assertSafe(parts, safety);
    const at = parts.flags.indexOf("--name");
    const name = verb === "run" ? parts.flags[at + 1] : undefined;
    await mkdir(this.configDir, { recursive: true });
    if (name !== undefined) await this.removals.get(name);
    const child = spawn(this.docker, dockerArgv(parts), {
      env: this.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let killed = false;
    return {
      child,
      cwd: options.cwd ?? "/",
      kill: () => {
        killTree(child);
        if (killed) return;
        killed = true;
        // Killing the CLI does not stop the container; removing it does. Its anonymous volume goes too.
        if (name !== undefined) this.remove(name);
      },
    };
  }

  private async raw(args: readonly string[], timeoutMs: number = EXEC_TIMEOUT_MS): Promise<DockerResult> {
    assertNoHostPaths(args, this.options);
    await mkdir(this.configDir, { recursive: true });
    const result = await exec(this.docker, [...args], this.env, timeoutMs);
    if (result.error !== undefined || result.code !== 0) {
      const detail = result.error ?? (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`);
      throw new Error(
        `docker ${args.slice(0, 2).join(" ")} failed: ${detail.split("\n").slice(-3).join(" ")}`,
      );
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }

  /** `docker rm -f -v <name>`, and what a start of the same name waits for. */
  private remove(name: string): void {
    const removal = this.exec(["rm", "-f", "-v", name]).then(
      () => undefined,
      (err: unknown) => {
        // A container that ended by itself is already gone (--rm).
        if (!errorMessage(err).includes("No such container")) console.error(errorMessage(err));
      },
    );
    const tracked = removal.finally(() => {
      if (this.removals.get(name) === tracked) this.removals.delete(name);
    });
    this.removals.set(name, tracked);
  }
}
