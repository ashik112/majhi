import { lookup } from "node:dns/promises";
import { connect as tlsConnect } from "node:tls";
import type { OpsMonitor, OpsServiceDef } from "@majhi/shared";

/**
 * The checks of the ops watch: cheap code, no model. Each answers one yes or no and one plain line.
 * What a monitored page says is data: a response body is read only as far as a keyword match (a
 * boolean) and never kept, shown or sent anywhere. The lines are built from fixed words, the status
 * and numbers, so nothing a remote server writes reaches the owner's screen or the captain.
 */

export interface ProbeResult {
  ok: boolean;
  /** One line. */
  detail: string;
  /** Time to the first byte, for the latency line. */
  ms?: number;
  /** Failing, but only a warning: a certificate with days left. Its incident is capped at medium. */
  warn?: boolean;
}

export type MonitorRead = { state: "ok"; value: number } | { state: "unavailable"; why: string };

export interface ProbePorts {
  fetch: typeof fetch;
  tls(host: string, port: number, timeoutMs: number): Promise<{ validTo: Date; authorized: boolean }>;
  lookup(host: string): Promise<string[]>;
  /** The monitoring connection's read. Absent: no connection to ask. */
  monitor?: (org: string, monitor: OpsMonitor) => Promise<MonitorRead>;
  now(): Date;
}

export const HTTP_TIMEOUT_MS = 10_000;
const TLS_TIMEOUT_MS = 8_000;
/** At most this much of a body is looked through for a keyword. */
export const KEYWORD_SCAN_BYTES = 256 * 1024;
/** A certificate this close to its end is a failing check, with the service's full impact. */
export const TLS_FAIL_DAYS = 3;
/** ... and this close a warning. */
export const TLS_WARN_DAYS = 14;
const DAY_MS = 86_400_000;

/** An http or https URL without a sign-in inside it, or the problem. */
export function urlProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `"${raw.slice(0, 80)}" is not a URL.`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Use an http or https address.";
  }
  if (url.username !== "" || url.password !== "") {
    return "Leave the sign-in out of the URL. A password does not belong in a check.";
  }
  return undefined;
}

/** Words for what went wrong, from the error's code, never from a message that could carry remote text. */
export function describeFailure(err: unknown): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return `no answer in ${HTTP_TIMEOUT_MS / 1000} s`;
  }
  const code = codeOf(err);
  switch (code) {
    case "ECONNREFUSED":
      return "connection refused";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "name does not resolve";
    case "ECONNRESET":
    case "UND_ERR_SOCKET":
      return "connection dropped";
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return "connection timed out";
    default:
      break;
  }
  if (code !== undefined && /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) {
    return "certificate problem";
  }
  return "no answer";
}

function codeOf(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 4; depth += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Whether the body holds the keyword, reading at most `limit` bytes and keeping only a short tail. */
export async function bodyHasKeyword(
  body: ReadableStream<Uint8Array> | null,
  keyword: string,
  limit = KEYWORD_SCAN_BYTES,
): Promise<boolean> {
  if (body === null) return false;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  let read = 0;
  try {
    while (read < limit) {
      const { done, value } = await reader.read();
      if (done) return false;
      read += value.byteLength;
      const window = tail + decoder.decode(value, { stream: true });
      if (window.includes(keyword)) return true;
      const keep = Math.max(0, keyword.length - 1);
      tail = keep === 0 ? "" : window.slice(-keep);
    }
    return false;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

export async function httpProbe(def: OpsServiceDef, ports: ProbePorts): Promise<ProbeResult> {
  const started = Date.now();
  let res: Response;
  try {
    res = await ports.fetch(def.url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { "user-agent": "majhi-watch" },
    });
  } catch (err) {
    return { ok: false, detail: describeFailure(err) };
  }
  const ms = Math.max(0, Date.now() - started);
  const statusOk = def.expectStatus === undefined ? res.status < 400 : res.status === def.expectStatus;
  if (!statusOk) {
    void res.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      detail:
        def.expectStatus === undefined
          ? `status ${res.status}`
          : `status ${res.status}, expected ${def.expectStatus}`,
      ms,
    };
  }
  if (def.keyword !== undefined && def.keyword !== "") {
    let found = false;
    try {
      found = await bodyHasKeyword(res.body, def.keyword);
    } catch {
      found = false;
    }
    if (!found) return { ok: false, detail: "the expected text is missing", ms };
  } else {
    void res.body?.cancel().catch(() => undefined);
  }
  if (def.maxLatencyMs !== undefined && ms > def.maxLatencyMs) {
    return { ok: false, detail: `slow: ${ms} ms, limit ${def.maxLatencyMs} ms`, ms };
  }
  return { ok: true, detail: `status ${res.status}, ${ms} ms`, ms };
}

export async function tlsProbe(def: OpsServiceDef, ports: ProbePorts): Promise<ProbeResult> {
  let url: URL;
  try {
    url = new URL(def.url);
  } catch {
    return { ok: false, detail: "not a URL" };
  }
  if (url.protocol !== "https:") return { ok: true, detail: "not https, no certificate to watch" };
  try {
    const cert = await ports.tls(url.hostname, url.port === "" ? 443 : Number(url.port), TLS_TIMEOUT_MS);
    const days = Math.floor((cert.validTo.getTime() - ports.now().getTime()) / DAY_MS);
    if (days < 0)
      return { ok: false, detail: `certificate expired ${-days} ${-days === 1 ? "day" : "days"} ago` };
    if (!cert.authorized) return { ok: false, detail: "certificate is not trusted" };
    if (days <= TLS_FAIL_DAYS) {
      return { ok: false, detail: `certificate expires in ${days} ${days === 1 ? "day" : "days"}` };
    }
    if (days <= TLS_WARN_DAYS) {
      return { ok: false, warn: true, detail: `certificate expires in ${days} days` };
    }
    return { ok: true, detail: `certificate valid for ${days} more days` };
  } catch (err) {
    return { ok: false, detail: `certificate could not be read (${describeFailure(err)})` };
  }
}

export async function dnsProbe(def: OpsServiceDef, ports: ProbePorts): Promise<ProbeResult> {
  let host: string;
  try {
    host = new URL(def.url).hostname;
  } catch {
    return { ok: false, detail: "not a URL" };
  }
  try {
    const addresses = await ports.lookup(host);
    return addresses.length > 0
      ? {
          ok: true,
          detail: `resolves to ${addresses.length} ${addresses.length === 1 ? "address" : "addresses"}`,
        }
      : { ok: false, detail: "name does not resolve" };
  } catch {
    return { ok: false, detail: "name does not resolve" };
  }
}

/** The value at a path like `data.rows.0.rate`; `-1` is an array's last item. Own properties only. */
export function valueAt(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.split(".")) {
    if (Array.isArray(cur) && /^-?\d+$/.test(part)) {
      const i = Number(part);
      cur = cur[i < 0 ? cur.length + i : i];
      continue;
    }
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    if (!Object.hasOwn(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** The leaf paths of an answer, for a message that says what is there. At most `max`, never values. */
export function pathsOf(value: unknown, max = 12): string[] {
  const out: string[] = [];
  const walk = (v: unknown, at: string, depth: number) => {
    if (out.length >= max || depth > 6) return;
    if (Array.isArray(v)) {
      if (v.length > 0) walk(v[v.length - 1], at === "" ? "-1" : `${at}.-1`, depth + 1);
      return;
    }
    if (v !== null && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) walk(child, at === "" ? k : `${at}.${k}`, depth + 1);
      return;
    }
    if (at !== "") out.push(at);
  };
  walk(value, "", 0);
  return out;
}

/** A number at a path like `data.rows.0.rate`. Own properties only. */
export function numberAt(value: unknown, path: string): number | undefined {
  const cur = valueAt(value, path);
  if (typeof cur === "number" && Number.isFinite(cur)) return cur;
  if (typeof cur === "string" && cur.trim() !== "" && Number.isFinite(Number(cur))) return Number(cur);
  return undefined;
}

export async function monitorProbe(
  org: string,
  def: OpsServiceDef,
  ports: ProbePorts,
): Promise<ProbeResult | "unavailable"> {
  const monitor = def.monitor;
  if (monitor === undefined) return { ok: true, detail: "no monitor" };
  if (ports.monitor === undefined) return "unavailable";
  const read = await ports
    .monitor(org, monitor)
    .catch((): MonitorRead => ({ state: "unavailable", why: "failed" }));
  if (read.state === "unavailable") return "unavailable";
  const text = `${monitor.label} ${read.value}`;
  return read.value > monitor.max
    ? { ok: false, detail: `${text}, limit ${monitor.max}` }
    : { ok: true, detail: `${text}, limit ${monitor.max}` };
}

/** The real network behind the ports. */
export function systemPorts(
  parts: Pick<ProbePorts, "fetch" | "now"> & Partial<Pick<ProbePorts, "monitor">>,
): ProbePorts {
  return {
    ...parts,
    tls: (host, port, timeoutMs) =>
      new Promise((resolve, reject) => {
        const socket = tlsConnect(
          { host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs },
          () => {
            const cert = socket.getPeerCertificate();
            const authorized = socket.authorized;
            socket.end();
            const validTo = cert?.valid_to === undefined ? undefined : new Date(cert.valid_to);
            if (validTo === undefined || Number.isNaN(validTo.getTime())) reject(new Error("no certificate"));
            else resolve({ validTo, authorized });
          },
        );
        socket.once("timeout", () => {
          socket.destroy();
          reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
        });
        socket.once("error", reject);
      }),
    lookup: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
  };
}
