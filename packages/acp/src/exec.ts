import { type ChildProcess, spawn } from "node:child_process";

export interface ExecResult {
  /** Exit code, or null when the process did not start or was killed by the timeout. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process did not start, or timed out. */
  error?: string;
}

const MAX_OUTPUT = 64 * 1024;

/**
 * Kills a child started with `detached: true` and everything it spawned.
 * Adapters start the real CLI as their own child, so killing only the
 * adapter would leave the CLI running.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** Runs a command to completion with a timeout. Never rejects and never uses a shell. */
export function exec(
  command: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let error: string | undefined;
    let settled = false;
    const child = spawn(command, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(error ? { code, stdout, stderr, error } : { code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      error = `Timed out after ${Math.round(timeoutMs / 1000)}s`;
      killTree(child);
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      error = err.code === "ENOENT" ? `Command not found: ${command}` : err.message;
      finish(null);
    });
    child.on("close", (code) => finish(error ? null : code));
  });
}
