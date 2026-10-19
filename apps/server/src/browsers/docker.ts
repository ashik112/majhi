import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RunnerConfig } from "@majhi/acp";

const run = promisify(execFile);

/** What the browser containers need of the runner's docker setup. */
export type BrowserDockerConfig = Pick<RunnerConfig, "docker" | "cliEnv">;

/** Runs `docker args` with the runner's CLI environment and returns what it printed. */
export function dockerOf(cfg: BrowserDockerConfig): (args: string[]) => Promise<string> {
  return async (args) => {
    const { stdout } = await run(cfg.docker ?? "docker", args, {
      env: { ...cfg.cliEnv, DOCKER_CONFIG: cfg.cliEnv.DOCKER_CONFIG ?? "/tmp/majhi-docker" },
      timeout: 60_000,
    });
    return stdout;
  };
}

/** Waits until a container has printed `line`; throws when it stops first or `ms` pass. */
export async function waitForLine(
  docker: (args: string[]) => Promise<string>,
  container: string,
  line: string,
  ms: number,
): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    const out = await docker(["logs", "--tail", "20", container]).catch(() => "");
    if (out.includes(line)) return;
    const running = await docker(["inspect", "--format", "{{.State.Running}}", container]).catch(
      () => "false",
    );
    if (running.trim() !== "true") {
      throw new Error(`it stopped while starting: ${out.trim().split("\n").pop() ?? ""}`);
    }
    if (Date.now() > until) throw new Error("it did not open its ports in time");
    await new Promise((r) => setTimeout(r, 250));
  }
}
