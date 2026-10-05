import { execFile } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { dockerRunArgs, type RunnerConfig } from "@majhi/acp";
import { errorMessage, exitCode } from "../errors.ts";
import type { Runner } from "./setup.ts";

const run = promisify(execFile);

/** Starting a container takes a moment; a first pull of nothing is never needed (the image is local). */
const CHECK_TIMEOUT_MS = 120_000;
const PROBE_ACCOUNT = "_runner-check";
const MARKER = ".runner-check";
const SERENA_PROBE_ACCOUNT = "_serena-check";
/** Docker Desktop and OrbStack remount the host's folders now and then; a check that fails meanwhile passes moments later. */
const RETRY_AFTER_MS = 5_000;
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
  /** Pause before the one retry of a failed isolation check. Tests set it to 0. */
  retryAfterMs?: number;
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
  const first = await isolationOnce(input);
  if (first.ok || !first.retry) return verdict(first);
  await new Promise((resolve) => setTimeout(resolve, input.retryAfterMs ?? RETRY_AFTER_MS));
  return verdict(await isolationOnce(input));
}

/** The verdict without the internal retry flag. */
function verdict({ retry: _, ...v }: RunnerVerdict & { retry?: boolean }): RunnerVerdict {
  return v;
}

/**
 * One isolation check. A failure worth one more try is marked `retry`: not a run that saw what it
 * must not (that is real), not a rebuild, and not a timeout (a second one would double the wait).
 */
async function isolationOnce(input: RunnerCheckInput): Promise<RunnerVerdict & { retry?: boolean }> {
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
    return {
      ok: false,
      detail: out || "The runner check gave no answer.",
      retry: !out.startsWith("a run can see"),
    };
  } catch (err) {
    const { timedOut, ...said } = explain(err, cfg.image);
    return {
      ok: false,
      ...said,
      retry: !said.rebuild && !timedOut && !said.detail.startsWith("a run can see"),
    };
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
    const { timedOut: _, ...said } = explain(err, cfg.image);
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

/**
 * Why a check's runner failed, in plain words. The script's own answer (stdout) comes first;
 * otherwise Docker's stderr and whether the timeout killed it. Never the docker argv: execFile
 * puts it on the message's first line ("Command failed: docker run ..."), and it says nothing.
 */
function explain(err: unknown, image: string): { detail: string; rebuild?: boolean; timedOut?: boolean } {
  const { stdout, stderr, killed, signal } = err as {
    stdout?: unknown;
    stderr?: unknown;
    killed?: unknown;
    signal?: unknown;
  };
  const said = typeof stdout === "string" ? stdout.trim().split("\n").pop() : undefined;
  if (said) return { detail: said };
  const message = errorMessage(err);
  const text =
    typeof stderr === "string"
      ? stderr
      : message.startsWith("Command failed:")
        ? message.split("\n").slice(1).join("\n")
        : message;
  if (killed === true || typeof signal === "string") {
    const last = dockerSaid(text);
    const stopped =
      killed === true
        ? `Docker did not answer within ${CHECK_TIMEOUT_MS / 1000} s, so the check was stopped.`
        : `docker was stopped by ${String(signal)}.`;
    return { detail: last ? `${stopped} Docker last said: ${last}` : stopped, timedOut: killed === true };
  }
  if (/No such image|Unable to find image|pull access denied/i.test(text)) {
    return { detail: `The runner image ${image} is missing, so agents cannot run.`, rebuild: true };
  }
  if (text.includes("majhi-netguard")) {
    return {
      detail: `The runner image ${image} is older than this majhi and has no network guard, so agents cannot start.`,
      rebuild: true,
    };
  }
  if (/permission denied.*docker\.sock|Cannot connect to the Docker daemon/i.test(text)) {
    return { detail: "majhi cannot reach Docker to start agent runs.", rebuild: true };
  }
  if (/is already in use by container/i.test(text)) {
    return { detail: "A container with the check's name was still there; Docker had not removed it yet." };
  }
  const source = /bind source path does not exist: (\S+)/i.exec(text);
  if (source || /invalid mount config/i.test(text)) {
    return {
      detail: `Docker could not find a folder to mount${source ? ` (${source[1]?.replace(/\.$/, "")})` : ""}; this happens briefly while Docker remounts the host's folders.`,
    };
  }
  if (/context deadline exceeded|i\/o timeout|daemon is not responding|TLS handshake timeout/i.test(text)) {
    return { detail: "Docker did not respond in time; it may be busy or restarting." };
  }
  const last = dockerSaid(text);
  if (last) return { detail: last };
  const code = exitCode(err);
  return {
    detail: code === undefined ? "docker failed without saying why." : `docker exited with code ${code}.`,
  };
}

/** Docker's last meaningful stderr line, without its "docker:" prefixes and help hints. */
function dockerSaid(stderr: string): string | undefined {
  return stderr
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^docker: /i, "")
        .replace(/^Error response from daemon: /i, ""),
    )
    .filter((line) => line !== "" && !/^(See|Run) 'docker .*--help'/i.test(line))
    .pop();
}
