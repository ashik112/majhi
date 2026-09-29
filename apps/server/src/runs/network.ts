import { existsSync } from "node:fs";

/**
 * Offline detection (SPEC 5.7): a probe every 20 s plus agent errors that look like network
 * failures. The probe is injectable so tests never reach the network.
 */

/** Resolves true when the network works. */
export type Probe = () => Promise<boolean>;

export const PROBE_INTERVAL_MS = 20_000;
const PROBE_TIMEOUT_MS = 5_000;

/** The API hosts of the tools majhi runs (Claude Code, Codex). */
export const TOOL_API_HOSTS = ["https://api.anthropic.com", "https://api.openai.com"] as const;

/** A HEAD request to each host. Any HTTP answer counts as online; only failing to connect is offline. */
export function httpProbe(hosts: readonly string[] = TOOL_API_HOSTS, fetchImpl: typeof fetch = fetch): Probe {
  return async () => {
    for (const host of hosts) {
      try {
        await fetchImpl(host, { method: "HEAD", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        return true;
      } catch {
        // Try the next host.
      }
    }
    return false;
  };
}

/** Offline while `path` exists. For end-to-end tests, which cannot cut the network. */
export function fileProbe(path: string): Probe {
  return async () => !existsSync(path);
}

/** `MAJHI_NET_PROBE`: `http` (default), `off` (always online), or `file:<path>`. */
export function probeFromSetting(setting: string | undefined): Probe {
  if (setting === "off") return async () => true;
  if (setting?.startsWith("file:")) return fileProbe(setting.slice(5));
  return httpProbe();
}

/** Agent and adapter errors that mean the machine lost its connection, not that the agent failed. */
export function looksLikeNetworkError(message: string): boolean {
  return /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|fetch failed|socket hang up|getaddrinfo|network (error|is unreachable)|connection (error|reset|refused|timed out)|unable to connect|internet connection/i.test(
    message,
  );
}

export interface WatchDeps {
  probe: Probe;
  /** Called on every change between online and offline. */
  onChange: (online: boolean) => void;
  intervalMs?: number;
}

/**
 * Online until a probe fails twice in a row (the second try right after the first, so one
 * dropped packet is not an outage). Online again on the first probe that works.
 */
export class NetworkWatch {
  private state = true;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<boolean> | undefined;

  constructor(private readonly deps: WatchDeps) {}

  get online(): boolean {
    return this.state;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.check(), this.deps.intervalMs ?? PROBE_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Probes now (joining a probe already running) and returns whether the network works. */
  check(): Promise<boolean> {
    if (this.running === undefined) {
      this.running = this.probeTwice().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  private async probeTwice(): Promise<boolean> {
    const ok = (await this.safeProbe()) || (await this.safeProbe());
    if (ok !== this.state) {
      this.state = ok;
      this.deps.onChange(ok);
    }
    return ok;
  }

  private async safeProbe(): Promise<boolean> {
    try {
      return await this.deps.probe();
    } catch {
      return false;
    }
  }
}
