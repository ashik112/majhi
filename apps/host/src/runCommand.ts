import { spawn } from "node:child_process";
import type { RunFn, RunResult } from "./ssh.ts";

const MAX_OUTPUT = 64 * 1024;

/**
 * Runs a program with an exact environment, stdin closed and no controlling
 * terminal (`detached` starts a new session), so nothing can prompt. Never
 * rejects: a program that cannot start or runs too long gives `code: null`.
 * Arguments are never put in an error, so a secret in one cannot leak.
 */
export const runCommand: RunFn = (file, args, options) =>
  new Promise<RunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const child = spawn(file, [...args], {
      env: options.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const timer = setTimeout(() => {
      // Its own process group (`detached`), so what it started goes too: a test run is a tree.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(null);
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8");
    });
    // Closed at once without input, so nothing can wait on it.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
