import { existsSync } from "node:fs";

/**
 * Offline detection (SPEC 5.7): a probe every 15 s plus agent errors that look like network
 * failures. The probe is injectable so tests never reach the network.
 */

/** Resolves true when the network works. */
export type Probe = () => Promise<boolean>;

export const PROBE_INTERVAL_MS = 15_000;
/** Probes per outage: majhi counts as offline once the probe failed for this many intervals (45 s). */
export const OFFLINE_AFTER_INTERVALS = 3;
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

/**
 * API errors the provider says are temporary (overloaded, 5xx). Not usage limits (429 and
 * "limit reached"): those wait for the window to reset instead.
 */
export function looksLikeOverload(message: string): boolean {
  if (/\b429\b|rate.?limit|usage limit|limit reached/i.test(message)) return false;
  return /\b(529|500|502|503|504)\b|overloaded|internal server error|service unavailable|bad gateway|gateway timeout|temporarily unavailable/i.test(
    message,
  );
}

/** Waits between tries when the model's API is overloaded: 30 s, 1, 2, 4 and 8 minutes. */
export const OVERLOAD_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 480_000] as const;

export interface WatchDeps {
  probe: Probe;
  /**
   * `false` when majhi counts as offline: the probe failed for `offlineAfterMs`. `true` on the
   * first probe that works after any failed one, whether or not offline was declared, so runs a
   * network error paused during a short blip continue.
   */
  onChange: (online: boolean) => void;
  /** Each failed probe after offline was declared, so turns that went quiet since can pause too. */
  onStillOffline?: () => void;
  intervalMs?: number;
  /** How long the probe must fail before majhi counts as offline. Default: three intervals. */
  offlineAfterMs?: number;
  /** In ms. Tests pass a fake clock. */
  now?: () => number;
}

/**
 * Online until the probe has failed for `offlineAfterMs` (45 s by default): a VPN or DNS blip
 * shorter than that pauses nothing. Each probe tries twice, right after each other, so one
 * dropped packet is not a failure. Online again on the first probe that works.
 */
export class NetworkWatch {
  private state = true;
  /** When the current run of failed probes began. */
  private failingSince: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<boolean> | undefined;
  private readonly intervalMs: number;
  private readonly offlineAfterMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: WatchDeps) {
    this.intervalMs = deps.intervalMs ?? PROBE_INTERVAL_MS;
    this.offlineAfterMs = deps.offlineAfterMs ?? this.intervalMs * OFFLINE_AFTER_INTERVALS;
    this.now = deps.now ?? Date.now;
  }

  get online(): boolean {
    return this.state;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Probes now (joining a probe already running) and returns whether this probe reached the network. */
  check(): Promise<boolean> {
    if (this.running === undefined) {
      this.running = this.round().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  private async round(): Promise<boolean> {
    const ok = (await this.safeProbe()) || (await this.safeProbe());
    if (ok) {
      const recovered = this.failingSince !== undefined || !this.state;
      this.failingSince = undefined;
      this.state = true;
      if (recovered) this.deps.onChange(true);
      return true;
    }
    const now = this.now();
    this.failingSince ??= now;
    if (!this.state) this.deps.onStillOffline?.();
    else if (now - this.failingSince >= this.offlineAfterMs) {
      this.state = false;
      this.deps.onChange(false);
    }
    return false;
  }

  private async safeProbe(): Promise<boolean> {
    try {
      return await this.deps.probe();
    } catch {
      return false;
    }
  }
}
