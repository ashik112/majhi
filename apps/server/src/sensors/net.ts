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

/** An answer longer than the caller allowed. The rest was not read. */
export class TooLarge extends Error {}

export interface NetOptions {
  base?: typeof fetch;
  /** Extra hosts (with port when it is not the default) beyond `SENSOR_HOSTS`. */
  allow?: readonly string[];
  /** Exactly these hosts and no others: the sensors' own list does not apply. */
  only?: readonly string[];
  sleep?: (ms: number) => Promise<void>;
}

/** A text answer, read up to a limit. */
export interface TextAnswer {
  status: number;
  body: string;
  contentType: string;
  etag: string | undefined;
  /** The address the answer came from, after redirects. */
  url: string;
}

const MAX_REDIRECTS = 3;

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
    const hosts = opts.only ?? [...SENSOR_HOSTS, ...(opts.allow ?? [])];
    this.allowed = new Set(hosts.map((h) => h.toLowerCase()));
    this.base = opts.base ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** A net that reaches only these hosts, with this one's transport: for a playbook that has its own list. */
  restrictedTo(hosts: readonly string[]): Net {
    return new Net({ base: this.base, only: hosts, sleep: this.sleep });
  }

  /**
   * A text request: a feed or a robots.txt. The host list holds on every redirect (up to three), the
   * answer is read up to `maxBytes` and then refused as `TooLarge`, and 429 and 5xx are retried like
   * `json` does. Nothing is sent to a host that is not on the list.
   */
  async text(url: string, init: { accept?: string; etag?: string; maxBytes: number }): Promise<TextAnswer> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const target = this.guard(current);
      const headers: Record<string, string> = {
        accept: init.accept ?? "*/*",
        "user-agent": "majhi-sensors",
      };
      if (init.etag !== undefined && hop === 0) headers["if-none-match"] = init.etag;
      let lastWhy = "no answer";
      let answer: Response | undefined;
      for (let attempt = 1; attempt <= TRIES; attempt += 1) {
        let wait = Math.min(1_000 * 2 ** attempt, MAX_WAIT_MS);
        try {
          this.sent.set(target.host, (this.sent.get(target.host) ?? 0) + 1);
          const res = await this.base(current, {
            method: "GET",
            headers,
            redirect: "manual",
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (res.status === 429 || res.status >= 500) {
            lastWhy = `status ${res.status}`;
            const after = Number(res.headers.get("retry-after"));
            if (Number.isFinite(after) && after > 0) wait = Math.min(after * 1_000, MAX_WAIT_MS);
            void res.body?.cancel().catch(() => undefined);
          } else {
            answer = res;
            break;
          }
        } catch {
          lastWhy = "the network failed";
        }
        if (attempt < TRIES) await this.sleep(wait);
      }
      if (answer === undefined) throw new Unavailable(`${target.host} did not answer (${lastWhy}).`);
      const location = answer.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(answer.status) && location !== null) {
        void answer.body?.cancel().catch(() => undefined);
        try {
          current = new URL(location, current).toString();
        } catch {
          throw new HostRefused(`"${location}" is not a URL.`);
        }
        continue;
      }
      const body = answer.status === 304 ? "" : await readLimited(answer, init.maxBytes);
      return {
        status: answer.status,
        body,
        contentType: answer.headers.get("content-type") ?? "",
        etag: answer.headers.get("etag") ?? undefined,
        url: current,
      };
    }
    throw new Unavailable(`${new URL(url).host} redirected too many times.`);
  }

  /** The URL, or `HostRefused` when it is not a URL or its host is not on the list. */
  private guard(url: string): URL {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new HostRefused(`"${url}" is not a URL.`);
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new HostRefused(`majhi reaches http and https addresses only, not "${target.protocol}".`);
    }
    if (!this.allowed.has(target.host.toLowerCase())) {
      throw new HostRefused(`majhi does not send sensor requests to ${target.host}.`);
    }
    return target;
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

/** Reads a response as text, stopping with `TooLarge` once it passes `max` bytes. */
async function readLimited(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    void res.body?.cancel().catch(() => undefined);
    throw new TooLarge(`The answer is ${declared} bytes, more than the ${max} allowed.`);
  }
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel().catch(() => undefined);
      throw new TooLarge(`The answer is longer than the ${max} bytes allowed.`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
