import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { exec, killTree, type Spawned } from "@majhi/acp";
import { errorMessage } from "../errors.ts";
import { assertNoHostPaths, ContainerRefused, type HostPaths } from "./args.ts";

/** A short call, like `docker ps`, waits this long at most. */
const EXEC_TIMEOUT_MS = 30_000;

/** Names of containers majhi removes by name. Nothing else can be removed this way. */
const OWN_CONTAINER = /^majhi-[a-z0-9][a-z0-9-]*$/;

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

/**
 * The docker CLI as majhi's server uses it for agents' containers. The environment is the CLI's own
 * (`cliEnv`) plus a config folder in `<majhiHome>/cache/docker`, where buildx keeps the metadata of the
 * task builders across restarts. Every argument of every call is scanned for host paths that no
 * container may see. The grammar of the call itself is checked by the builders in `args.ts`.
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

  /** Runs a short call and resolves with its output. Rejects with docker's own message when it fails. */
  async exec(args: readonly string[], options: { timeoutMs?: number } = {}): Promise<DockerResult> {
    assertNoHostPaths(args, this.options);
    await mkdir(this.configDir, { recursive: true });
    const result = await exec(this.docker, [...args], this.env, options.timeoutMs ?? EXEC_TIMEOUT_MS);
    if (result.error !== undefined || result.code !== 0) {
      const detail = result.error ?? (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`);
      throw new Error(
        `docker ${args.slice(0, 2).join(" ")} failed: ${detail.split("\n").slice(-3).join(" ")}`,
      );
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }

  /**
   * Starts a call that runs attached, like `docker run --rm ...` without `-d`: its output is the
   * process's output. `name` is the container it starts, removed on `kill()`; pass none for a build, which
   * starts no container of its own. `kill()` stops the CLI and removes the container, and a new start
   * with the same name waits for that removal.
   */
  async attached(
    args: readonly string[],
    name: string | undefined,
    options: { cwd?: string } = {},
  ): Promise<Spawned> {
    assertNoHostPaths(args, this.options);
    if (name !== undefined && !OWN_CONTAINER.test(name)) {
      throw new ContainerRefused(`${name} is not a container of majhi's.`);
    }
    await mkdir(this.configDir, { recursive: true });
    if (name !== undefined) await this.removals.get(name);
    const child = spawn(this.docker, [...args], {
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
