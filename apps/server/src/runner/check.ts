import { execFile } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { dockerRunArgs, type RunnerConfig } from "@majhi/acp";
import { errorMessage } from "../errors.ts";
import type { Runner } from "./setup.ts";

const run = promisify(execFile);

/** Starting a container takes a moment; a first pull of nothing is never needed (the image is local). */
const CHECK_TIMEOUT_MS = 120_000;
const PROBE_ACCOUNT = "_runner-check";
const MARKER = ".runner-check";
const SERENA_PROBE_ACCOUNT = "_serena-check";
const IMAGE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Checks the fixed script. `$1` must be visible (the run's own account home works); every other
 * argument must not be (majhi's config, the secrets key, other accounts, SSH, the Docker socket).
 */
const SCRIPT = `test -f "$1" || { echo "the run's own account home is not mounted"; exit 2; }
shift
for p in "$@"; do if [ -e "$p" ]; then echo "a run can see $p"; exit 1; fi; done
echo isolated`;

export interface RunnerCheckInput {
  runner: Runner;
  majhiHome: string;
  hostHome: string;
  secretsKeyFile: string;
  /** Runs `docker` with these arguments. Tests replace it. */
  docker?: (args: string[], env: Record<string, string>) => Promise<{ stdout: string }>;
}

export interface RunnerVerdict {
  ok: boolean;
  detail: string;
  /** Rebuilding majhi fixes it: the runner image is missing or Docker is out of reach. */
  rebuild?: boolean;
}

/** Paths a run must never see. */
export async function hiddenPaths(input: Omit<RunnerCheckInput, "runner" | "docker">): Promise<string[]> {
  const { majhiHome } = input;
  const accounts = await readdir(join(majhiHome, "accounts")).catch(() => [] as string[]);
  return [
    join(majhiHome, "majhi.yaml"),
    join(majhiHome, "majhi.db"),
    join(majhiHome, "secrets.age"),
    join(majhiHome, "agents"),
    join(majhiHome, ".git"),
    // The SSH agent sockets on Linux and WSL2: the helper's forwarder and majhi's own agent.
    join(majhiHome, "run"),
    ...accounts.filter((a) => a !== PROBE_ACCOUNT).map((a) => join(majhiHome, "accounts", a)),
    input.secretsKeyFile,
    "/run/secrets/majhi_key",
    join(input.hostHome, ".ssh"),
    "/var/run/docker.sock",
  ];
}

/**
 * Starts a throwaway runner exactly the way agent runs start (same image, network, user and
 * mount rules), with a probe account home, and asks it what it can see. This is the proof that
 * an agent run cannot read `~/.majhi`, the secrets key or another account's home.
 */
export async function checkRunnerIsolation(input: RunnerCheckInput): Promise<RunnerVerdict> {
  const { runner } = input;
  const cfg: RunnerConfig = runner.config;
  const docker =
    input.docker ??
    ((args: string[], env: Record<string, string>) =>
      run(cfg.docker ?? "docker", args, { env, timeout: CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024 }));
  const probeHome = join(input.majhiHome, "accounts", PROBE_ACCOUNT);
  try {
    await cfg.ready?.();
    await mkdir(probeHome, { recursive: true, mode: 0o700 });
    await writeFile(join(probeHome, MARKER), "ok\n");
    const hidden = await hiddenPaths(input);
    const args = dockerRunArgs(
      {
        command: { command: "sh", args: ["-c", SCRIPT, "sh", join(probeHome, MARKER), ...hidden] },
        env: { PATH: IMAGE_PATH, HOME: probeHome },
        cwd: "/tmp",
        scratch: true,
        account: { tool: "claude", home: probeHome },
      },
      cfg,
      `majhi-run-check-${Date.now().toString(36)}`,
    );
    const { stdout } = await docker(args, { ...cfg.cliEnv, DOCKER_CONFIG: "/tmp/majhi-docker" });
    const out = stdout.trim().split("\n").pop() ?? "";
    if (out === "isolated") {
      return {
        ok: true,
        detail: "Agent runs are isolated: they cannot see ~/.majhi, the secrets key or other accounts.",
      };
    }
    return { ok: false, detail: out || "The runner check gave no answer." };
  } catch (err) {
    return { ok: false, ...explain(err, cfg.image) };
  } finally {
    await rm(probeHome, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Serena (5.9 item 6) must start in the runner: a throwaway runner, started like an agent run,
 * asks the installed `serena` for its version. A runner image built before Serena was added
 * answers "not found", which Rebuild majhi fixes.
 */
export async function checkSerena(
  input: Pick<RunnerCheckInput, "runner" | "majhiHome" | "docker"> & { command: string },
): Promise<RunnerVerdict> {
  const cfg: RunnerConfig = input.runner.config;
  const docker =
    input.docker ??
    ((args: string[], env: Record<string, string>) =>
      run(cfg.docker ?? "docker", args, { env, timeout: CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024 }));
  const probeHome = join(input.majhiHome, "accounts", SERENA_PROBE_ACCOUNT);
  try {
    await cfg.ready?.();
    await mkdir(probeHome, { recursive: true, mode: 0o700 });
    const args = dockerRunArgs(
      {
        command: {
          command: "sh",
          args: [
            "-c",
            'test -x "$1" || { echo "not installed"; exit 3; }; "$1" --version 2>&1 | tail -n 1',
            "sh",
            input.command,
          ],
        },
        env: { PATH: IMAGE_PATH, HOME: probeHome },
        cwd: "/tmp",
        scratch: true,
        account: { tool: "claude", home: probeHome },
      },
      cfg,
      `majhi-run-serena-${Date.now().toString(36)}`,
    );
    const { stdout } = await docker(args, { ...cfg.cliEnv, DOCKER_CONFIG: "/tmp/majhi-docker" });
    const out = stdout.trim().split("\n").pop() ?? "";
    return out === ""
      ? { ok: false, detail: "Serena gave no answer in the runner." }
      : { ok: true, detail: `${out} starts in the runner` };
  } catch (err) {
    const said = explain(err, cfg.image);
    if (said.detail === "not installed") {
      return {
        ok: false,
        detail: "Serena is not in the runner image, so agents work without it.",
        rebuild: true,
      };
    }
    return { ok: false, ...said };
  } finally {
    await rm(probeHome, { recursive: true, force: true }).catch(() => undefined);
  }
}

function explain(err: unknown, image: string): { detail: string; rebuild?: boolean } {
  const stdout = (err as { stdout?: unknown }).stdout;
  const said = typeof stdout === "string" ? stdout.trim().split("\n").pop() : undefined;
  if (said) return { detail: said };
  const message = errorMessage(err);
  if (/No such image|Unable to find image|pull access denied/i.test(message)) {
    return { detail: `The runner image ${image} is missing, so agents cannot run.`, rebuild: true };
  }
  if (/permission denied.*docker\.sock|Cannot connect to the Docker daemon/i.test(message)) {
    return { detail: "majhi cannot reach Docker to start agent runs.", rebuild: true };
  }
  return { detail: message.split("\n", 1)[0] ?? message };
}
