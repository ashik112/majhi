import { type DockerRuntime, DockerRuntimeSchema } from "@majhi/shared";
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

/** HEAD and dirtiness of the majhi checkout. Undefined when git fails or the folder is not a checkout. */
export async function readRepo({ git, repo, env, exec }: GitContext): Promise<RepoState | undefined> {
  try {
    const opts = { cwd: repo, env, timeout: GIT_TIMEOUT_MS };
    const head = (await exec(git, ["rev-parse", "HEAD"], opts)).stdout.trim();
    if (!HEAD.test(head)) return undefined;
    const status = (await exec(git, ["status", "--porcelain"], opts)).stdout;
    return { commit: head, dirty: status.trim() !== "" };
  } catch {
    return undefined;
  }
}

/** Subjects of the commits after `from`, newest first, at most 20. Empty when `from` is not in this checkout. */
export async function commitSubjects(ctx: GitContext, from: string): Promise<string[]> {
  if (!HEAD.test(from)) return [];
  try {
    const { stdout } = await ctx.exec(ctx.git, ["log", "--format=%s", `${from}..HEAD`, "-n", "20"], {
      cwd: ctx.repo,
      env: ctx.env,
      timeout: GIT_TIMEOUT_MS,
    });
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
  docker: string | undefined;
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
      if (options.docker !== undefined) {
        try {
          const { stdout } = await options.exec(
            options.docker,
            ["info", "--format", "{{.OperatingSystem}}"],
            { cwd: "/", env: options.env, timeout: GIT_TIMEOUT_MS },
          );
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
