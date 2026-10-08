import { execFile } from "node:child_process";
import type { SshHostCheck } from "@majhi/shared";
import { readGitMeta } from "../scan/gitMeta.ts";

export interface SshRun {
  /** Exit code, or null when ssh could not start or timed out. Output is stdout and stderr together. */
  code: number | null;
  output: string;
}
export type SshRunFn = (args: readonly string[]) => Promise<SshRun>;

const PROBE_TIMEOUT_MS = 15_000;

/** Runs `ssh` (the binary in MAJHI_HOST_SSH, the same variable the host helper reads) with stdin closed. Never rejects. */
export const runSsh: SshRunFn = (args) =>
  new Promise((resolve) => {
    const child = execFile(
      process.env.MAJHI_HOST_SSH ?? "ssh",
      [...args],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === "number" ? err.code : null;
        resolve({ code, output: `${stdout}\n${stderr}` });
      },
    );
    child.stdin?.end();
  });

/** `user@host` or `host` from an ssh remote URL (scp-like or `ssh://`), else undefined. */
export function sshTargetOf(url: string): string | undefined {
  const scheme = /^(?:git\+ssh|ssh\+git|ssh):\/\/(?:([^@/\s]+)@)?(\[[^\]]+\]|[^:/\s]+)/i.exec(url);
  if (scheme?.[2]) return scheme[1] ? `${scheme[1]}@${scheme[2]}` : scheme[2];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return undefined;
  const scp = /^(?:([^@/\s]+)@)?([^:/\s]+):(?!\/\/)/.exec(url);
  if (scp?.[2]) return scp[1] ? `${scp[1]}@${scp[2]}` : scp[2];
  return undefined;
}

/** Each distinct ssh target used by a remote of the given repos. */
export async function sshTargets(repoPaths: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const path of repoPaths) {
    const meta = await readGitMeta(path).catch(() => undefined);
    for (const remote of meta?.remotes ?? []) {
      const target = sshTargetOf(remote.url);
      if (target !== undefined) found.add(target);
    }
  }
  return [...found].sort();
}

/** Judges ssh's exit and output. The answer is a fixed sentence, so no key material can leak. */
export function classifyProbe(run: SshRun): Pick<SshHostCheck, "state" | "detail"> {
  if (/permission denied/i.test(run.output)) {
    return { state: "auth-failed", detail: "The host did not accept any key ssh offered." };
  }
  if (run.code === null) return { state: "unreachable", detail: "ssh did not answer in time." };
  if (
    /could not resolve|timed out|refused|no route|unreachable|connection closed|reset by peer/i.test(
      run.output,
    )
  ) {
    return { state: "unreachable", detail: "majhi cannot connect to the host. Check its address and port." };
  }
  if (/host key verification failed/i.test(run.output)) {
    return { state: "unreachable", detail: "The host key is not in known_hosts." };
  }
  // Git hosts answer -T with a greeting and exit 0 or 1. Only exit 255 is an ssh failure.
  if (run.code === 255)
    return {
      state: "unreachable",
      detail: "majhi could not connect to the host. Check its address and port.",
    };
  return { state: "reachable", detail: "Reachable, and a key was accepted." };
}

/** `ssh -T -o BatchMode=yes -o ConnectTimeout=5` against each target, one after another. */
export async function probeHosts(
  targets: readonly string[],
  run: SshRunFn = runSsh,
): Promise<SshHostCheck[]> {
  const out: SshHostCheck[] = [];
  for (const host of targets) {
    const result = await run(["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host]);
    out.push({ host, ...classifyProbe(result) });
  }
  return out;
}

/** Keeps the last probe results, so `host.status` can show them without running ssh on every poll. */
export class SshHostProbe {
  private results: SshHostCheck[] | undefined;
  private at = 0;
  private running: Promise<SshHostCheck[]> | undefined;

  constructor(
    private readonly targets: () => Promise<string[]>,
    private readonly run: SshRunFn = runSsh,
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** The last results. Starts a refresh in the background when they are old. */
  cached(): SshHostCheck[] | undefined {
    if (this.running === undefined && this.now() - this.at > this.ttlMs)
      void this.refresh().catch(() => undefined);
    return this.results;
  }

  refresh(): Promise<SshHostCheck[]> {
    this.running ??= this.targets()
      .then((targets) => probeHosts(targets, this.run))
      .then((results) => {
        this.results = results;
        this.at = this.now();
        return results;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
}
