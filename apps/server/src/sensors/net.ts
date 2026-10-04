/**
 * What the sensors may reach, and how they ask. Every sensor request goes through `Net`: a host that is
 * not on the list is refused before anything is sent, so no code path can send a project's data to
 * another place. The requests themselves carry package names and versions (or a repo slug), never code,
 * paths or secrets. Rate limits and outages are handled here once: a 429 or 5xx waits and tries again
 * twice, then the sensor gives up for this run and keeps what it had.
 */

/** The public hosts sensors use. Git hosts of the owner's own connections are added per project. */
export const SENSOR_HOSTS = [
  "api.osv.dev",
  "endoflife.date",
  "api.github.com",
  "registry.npmjs.org",
] as const;

/** A request to a host that is not on the list. Nothing was sent. */
export class HostRefused extends Error {}

/** The upstream is down, slow or limiting us. Whatever the sensor had stays; it tries again later. */
export class Unavailable extends Error {}

const TIMEOUT_MS = 15_000;
const MAX_WAIT_MS = 30_000;
const TRIES = 3;

export interface NetOptions {
  base?: typeof fetch;
  /** Extra hosts (with port when it is not the default) beyond `SENSOR_HOSTS`. */
  allow?: readonly string[];
  sleep?: (ms: number) => Promise<void>;
}

export interface Answer {
  status: number;
  body: unknown;
  etag: string | undefined;
}

export class Net {
  private readonly allowed: Set<string>;
  private readonly base: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Requests sent, by host: for measuring what a run costs. */
  readonly sent = new Map<string, number>();

  constructor(opts: NetOptions = {}) {
    this.allowed = new Set([...SENSOR_HOSTS, ...(opts.allow ?? [])].map((h) => h.toLowerCase()));
    this.base = opts.base ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Lets one more host through: the git host of a project's own connection. */
  allowHost(host: string): void {
    this.allowed.add(host.toLowerCase());
  }

  total(): number {
    return [...this.sent.values()].reduce((a, b) => a + b, 0);
  }

  /** A JSON request. 304 and 404 are answers; 429, 5xx and a dead network are retried, then `Unavailable`. */
  async json(
    url: string,
    init: { method?: "GET" | "POST"; body?: unknown; headers?: Record<string, string>; etag?: string } = {},
  ): Promise<Answer> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new HostRefused(`"${url}" is not a URL.`);
    }
    if (!this.allowed.has(target.host.toLowerCase())) {
      throw new HostRefused(`majhi does not send sensor requests to ${target.host}.`);
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "majhi-sensors",
      ...init.headers,
    };
    if (init.etag !== undefined) headers["if-none-match"] = init.etag;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    let lastWhy = "no answer";
    for (let attempt = 1; attempt <= TRIES; attempt += 1) {
      let wait = Math.min(1_000 * 2 ** attempt, MAX_WAIT_MS);
      try {
        this.sent.set(target.host, (this.sent.get(target.host) ?? 0) + 1);
        const res = await this.base(url, {
          method: init.method ?? (init.body === undefined ? "GET" : "POST"),
          headers,
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status === 429 || res.status >= 500) {
          lastWhy = `status ${res.status}`;
          const after = Number(res.headers.get("retry-after"));
          if (Number.isFinite(after) && after > 0) wait = Math.min(after * 1_000, MAX_WAIT_MS);
          void res.body?.cancel().catch(() => undefined);
        } else {
          const text = res.status === 304 ? "" : await res.text();
          let body: unknown;
          try {
            body = text === "" ? undefined : (JSON.parse(text) as unknown);
          } catch {
            body = undefined;
          }
          return { status: res.status, body, etag: res.headers.get("etag") ?? undefined };
        }
      } catch {
        lastWhy = "the network failed";
      }
      if (attempt < TRIES) await this.sleep(wait);
    }
    throw new Unavailable(`${target.host} did not answer (${lastWhy}).`);
  }
}
