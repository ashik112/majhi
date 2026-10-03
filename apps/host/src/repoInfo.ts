import { type DockerRuntime, DockerRuntimeSchema } from "@majhi/shared";
import { filtersOff, GUARD_CONFIG, GUARD_ENV, LIST_FILTERS, withConfig } from "./gitGuard.ts";
import type { ExecFn } from "./remount.ts";

const GIT_TIMEOUT_MS = 10_000;
const HEAD = /^[0-9a-f]{7,64}$/;

export interface RepoState {
  /** The checkout's HEAD. */
  commit: string;
  /** True when the checkout has uncommitted changes. */
  dirty: boolean;
}

export interface GitContext {
  git: string;
  repo: string;
  env: NodeJS.ProcessEnv;
  exec: ExecFn;
}

/**
 * Runs git in the majhi checkout with the helper's guards (gitGuard.ts). Its `.git/config` is shared
 * with every task worktree of majhi, so an agent outside a container can plant a command there.
 * `readsFiles`: the command reads the work tree's files, so the filter drivers that config names
 * are turned off too.
 */
async function guardedGit(
  { git, repo, env, exec }: GitContext,
  args: string[],
  readsFiles = false,
): Promise<string> {
  const opts = { cwd: repo, env: { ...env, ...GUARD_ENV }, timeout: GIT_TIMEOUT_MS };
  if (readsFiles) {
    const listed = await exec(git, [...GUARD_CONFIG, ...LIST_FILTERS], opts).then(
      ({ stdout }) => stdout,
      () => "",
    );
    opts.env = withConfig(opts.env, filtersOff(listed));
  }
  return (await exec(git, [...GUARD_CONFIG, ...args], opts)).stdout;
}

/** HEAD and dirtiness of the majhi checkout. Undefined when git fails or the folder is not a checkout. */
export async function readRepo(ctx: GitContext): Promise<RepoState | undefined> {
  try {
    const head = (await guardedGit(ctx, ["rev-parse", "HEAD"])).trim();
    if (!HEAD.test(head)) return undefined;
    // A submodule's own config could name filters too; majhi has none.
    const status = await guardedGit(ctx, ["status", "--porcelain", "--ignore-submodules=all"], true);
    return { commit: head, dirty: status.trim() !== "" };
  } catch {
    return undefined;
  }
}

/** Subjects of the commits after `from`, newest first, at most 20. Empty when `from` is not in this checkout. */
export async function commitSubjects(ctx: GitContext, from: string): Promise<string[]> {
  if (!HEAD.test(from)) return [];
  try {
    // No signature check either: a planted `log.showSignature` would run the repo's `gpg.program`.
    const stdout = await guardedGit(ctx, [
      ...["log", "--no-ext-diff", "--no-textconv", "--no-show-signature"],
      ...["--format=%s", `${from}..HEAD`, "-n", "20"],
    ]);
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .slice(0, 20);
  } catch {
    return [];
  }
}

/** Reads what `docker info --format {{.OperatingSystem}}` printed. OrbStack says "OrbStack", Docker Desktop "Docker Desktop". */
export function parseDockerRuntime(operatingSystem: string): DockerRuntime {
  const text = operatingSystem.toLowerCase();
  if (text.includes("orbstack")) return DockerRuntimeSchema.parse("orbstack");
  if (text.includes("docker desktop")) return DockerRuntimeSchema.parse("docker-desktop");
  return "docker";
}

/** Keeps the checkout state and Docker runtime fresh in memory, because the poll header needs them at once. */
export function createHostFacts(options: {
  git: GitContext | undefined;
  /** The docker CLI, read at each refresh: on WSL2 it can appear after the helper started. */
  docker: () => string | undefined;
  env: NodeJS.ProcessEnv;
  exec: ExecFn;
}): {
  refresh(): Promise<void>;
  repo(): RepoState | undefined;
  runtime(): DockerRuntime | undefined;
} {
  let repo: RepoState | undefined;
  let runtime: DockerRuntime | undefined;
  return {
    async refresh() {
      if (options.git !== undefined) repo = await readRepo(options.git);
      const docker = options.docker();
      if (docker !== undefined) {
        try {
          const { stdout } = await options.exec(docker, ["info", "--format", "{{.OperatingSystem}}"], {
            cwd: "/",
            env: options.env,
            timeout: GIT_TIMEOUT_MS,
          });
          runtime = parseDockerRuntime(stdout);
        } catch {
          // Docker is not up. Keep the last answer.
        }
      }
    },
    repo: () => repo,
    runtime: () => runtime,
  };
}
