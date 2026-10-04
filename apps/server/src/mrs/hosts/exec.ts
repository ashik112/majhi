import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Added to a small base environment. Nothing else of majhi's own environment reaches the CLI. */
  env: Readonly<Record<string, string>>;
  /** Written to stdin, which is then closed. */
  input?: string | undefined;
  timeoutMs?: number | undefined;
}

export type Exec = (command: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>;

export const CLI_TIMEOUT_MS = 60_000;

/** What `gh api -i` and `glab api -i` print: the status line and headers, a blank line, the body. */
export function splitHttp(out: string): { status: number; etag: string | undefined; body: string } {
  const at = out.search(/\r?\n\r?\n/);
  const head = at === -1 ? out : out.slice(0, at);
  const body = at === -1 ? "" : out.slice(at).replace(/^\r?\n\r?\n/, "");
  const status = Number(/^HTTP\/\S+\s+(\d{3})/m.exec(head)?.[1] ?? 0);
  const etag = /^etag:\s*(\S.*?)\s*$/im.exec(head)?.[1];
  return { status, etag, body };
}

/**
 * Remembers the last answer of a GET with its ETag, so the next poll asks "if none match" and a
 * 304 costs the host nothing against its rate limit. In memory: a restart asks again in full.
 */
export class EtagCache {
  private readonly seen = new Map<string, { etag: string; value: unknown }>();
  get(key: string): { etag: string; value: unknown } | undefined {
    return this.seen.get(key);
  }
  set(key: string, etag: string | undefined, value: unknown): void {
    if (etag === undefined) this.seen.delete(key);
    else this.seen.set(key, { etag, value });
    if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value as string);
  }
}

/** The variables a host CLI needs to run and find its own config. Tokens are never among them. */
const BASE_ENV = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "XDG_CONFIG_HOME", "SSL_CERT_FILE"];

export function baseEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of BASE_ENV) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Runs a CLI with an argument list, never through a shell. Rejects only when it cannot start. */
export const runCli: Exec = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: { ...baseEnv(process.env), ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? CLI_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        err.code === "ENOENT"
          ? new Error(`${command} is not installed where majhi runs, so it cannot reach the host.`)
          : err,
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    // A CLI that exits before reading its input closes the pipe; that is its own error to report.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
