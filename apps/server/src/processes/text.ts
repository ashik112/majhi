import type { ProcessInfo } from "@majhi/shared";

/** `42s`, `3m 5s`, `1h 2m`. */
export function duration(from: string, to: string): string {
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** `cmd`, or `name (cmd)` when it has a name of its own. */
export function label(p: ProcessInfo): string {
  return p.name === p.command ? `\`${p.command}\`` : `${p.name} (\`${p.command}\`)`;
}

/** How it ended, in a few words. */
export function endLine(p: ProcessInfo): string {
  if (p.status === "running") return "running";
  if (p.status === "stopped") return `stopped by the ${p.stoppedBy ?? "task"}`;
  return p.exitCode === null || p.exitCode === undefined
    ? "ended by a signal"
    : `exited with code ${p.exitCode}`;
}

/** One short line for each prompt while anything runs, or undefined. */
export function runningLine(running: readonly ProcessInfo[]): string | undefined {
  if (running.length === 0) return undefined;
  const parts = running.map(
    (p) => `${p.id} ${label(p)}${p.port === undefined ? "" : ` on port ${p.port}`} by @${p.agent}`,
  );
  return `Running processes: ${parts.join("; ")}. Do not start a second copy; use the majhi-processes tool to read, stop or restart them.`;
}

/** A process as the `list` tool shows it. */
export function listLine(p: ProcessInfo, now: string): string {
  const time = duration(p.startedAt, p.endedAt ?? now);
  const port = p.port === undefined ? "" : `, port ${p.port}`;
  const wait = p.wait ? "" : ", wait: false";
  return `${p.id} ${label(p)} in ${p.cwd}: ${endLine(p)}, ${time}${port}${wait}, started by @${p.agent}`;
}
