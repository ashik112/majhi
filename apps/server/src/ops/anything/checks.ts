import { readOnlySqlProblem, type WatchCheck } from "@majhi/shared";
import { describeFailure, HTTP_TIMEOUT_MS, numberAt, urlProblem } from "../probes.ts";
import { hashText, jsonLd, mainText, parseHtml, parsePrice, selectFirst, textOf } from "./html.ts";

/**
 * The checks of the watches: cheap code, no model. Each reads one value and says it in fixed words.
 * What a page, a database or a server answers is data: numbers are parsed out of it and the rest is
 * dropped, so no remote text reaches the screen, the captain or a log. A secret from a connection lives
 * in a port's call only; an error is turned into a fixed phrase before anything is stored.
 */

/** The look could not tell. The message is a fixed phrase the owner can read. */
export class Unavailable extends Error {}

export interface Reading {
  number?: number | undefined;
  /** The value as the row shows it. */
  display: string;
  /** The thing is as it should be (a website answered, a keyword is there). */
  healthy: boolean;
  /** For `changed`: a number or a hash of the page's main text. */
  signature?: string | undefined;
  /** For `contains`: the text to look in. Never stored. */
  text?: string | undefined;
}

/** What a workspace connection holds, as the ports need it. `vars` and `fields` may hold secrets. */
export interface ConnInfo {
  org: string;
  type: string;
  name: string;
  fields: Record<string, string>;
  vars: Record<string, string>;
}

export interface RemoteResult {
  code: number | null;
  output: string;
}

export interface WatchPorts {
  fetch: typeof fetch;
  lookup(host: string): Promise<string[]>;
  now(): Date;
  connection(id: string): Promise<ConnInfo | undefined>;
  /** Runs one read-only statement and returns its first value as text. */
  sql(engine: "postgres" | "mysql", url: string, query: string, timeoutMs: number): Promise<string>;
  /** Runs Redis commands and returns each reply as text. */
  redis(url: string, commands: readonly string[][], timeoutMs: number): Promise<string[]>;
  ssh(alias: string, command: string): Promise<RemoteResult>;
  monitor(connection: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
  /**
   * The fingerprint of a file or folder inside a project's checkout in this workspace: size and
   * modification time, never contents. `missing` when it is not there. Throws Unavailable for a
   * project of another workspace or a path that leaves the checkout.
   */
  pathPrint(org: string, project: string, path: string): Promise<string>;
}

const URL_VARS: Record<"postgres" | "mysql" | "redis", string[]> = {
  postgres: ["DATABASE_URL", "POSTGRES_URL", "POSTGRESQL_URL", "PG_URL", "DB_URL"],
  mysql: ["MYSQL_URL", "DATABASE_URL", "DB_URL"],
  redis: ["REDIS_URL", "REDIS_TLS_URL", "KV_URL"],
};
const SQL_MS = 15_000;
const BODY_LIMIT = 1_500_000;

export function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** The connection, in this workspace, of one of the types. */
async function connectionOf(
  ports: WatchPorts,
  org: string,
  id: string,
  types: readonly string[],
): Promise<ConnInfo> {
  const found = await ports.connection(id);
  if (found === undefined) throw new Unavailable("the connection is gone");
  if (found.org !== org) throw new Unavailable("the connection belongs to another workspace");
  if (!types.includes(found.type)) throw new Unavailable("this connection is the wrong type for this watch");
  return found;
}

function urlFrom(conn: ConnInfo, kind: "postgres" | "mysql" | "redis"): string {
  for (const name of URL_VARS[kind]) {
    const v = conn.vars[name];
    if (v !== undefined && v !== "") return v;
  }
  throw new Unavailable(`the connection has no ${URL_VARS[kind][0]} variable`);
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof Unavailable) throw err;
    // Never the error's own text: it can carry an address or a password.
    throw new Unavailable(describeFailure(err) === "no answer" ? "the check failed" : describeFailure(err));
  }
}

function numberOfText(text: string): number | undefined {
  const m = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(text.trim());
  if (m === null) return undefined;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : undefined;
}

// Hosts ------------------------------------------------------------------------------

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

export function privateAddress(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (a === "::1" || a === "::" || a.startsWith("fe80:") || /^f[cd]/.test(a)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  const v4 = mapped?.[1] ?? a;
  return PRIVATE_V4.some((re) => re.test(v4));
}

/** Why a page may not be fetched (it is on this machine or its network), or undefined. */
export async function publicHostProblem(
  host: string,
  ports: Pick<WatchPorts, "lookup">,
): Promise<string | undefined> {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) {
    return "That address is on this machine's network. Only public pages are read.";
  }
  if (/^[\d.]+$/.test(h) || h.includes(":")) {
    return privateAddress(h)
      ? "That address is on this machine's network. Only public pages are read."
      : undefined;
  }
  try {
    const addresses = await ports.lookup(h);
    if (addresses.some(privateAddress)) {
      return "That address is on this machine's network. Only public pages are read.";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function readBody(res: Response, limit: number): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let read = 0;
  try {
    while (read < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return out;
}

/**
 * A public page, fetched the way a stranger would: no cookies, no sign-in, no headers of the owner's.
 * Redirects are followed by hand so each hop is checked against the public-host rule.
 */
export async function fetchPublicPage(
  url: string,
  ports: WatchPorts,
): Promise<{ status: number; body: string; ms: number }> {
  const problem = urlProblem(url);
  if (problem !== undefined) throw new Unavailable(problem);
  let target = url;
  const started = Date.now();
  for (let hop = 0; hop < 5; hop += 1) {
    const hostProblem = await publicHostProblem(new URL(target).hostname, ports);
    if (hostProblem !== undefined) throw new Unavailable(hostProblem);
    const res = await guarded(() =>
      ports.fetch(target, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; majhi-watch)",
          accept: "text/html,application/json;q=0.9,*/*;q=0.5",
        },
      }),
    );
    if (res.status >= 300 && res.status < 400 && res.headers.get("location") !== null) {
      void res.body?.cancel().catch(() => undefined);
      const next = new URL(res.headers.get("location") ?? "", target).href;
      if (urlProblem(next) !== undefined)
        throw new Unavailable("the page redirects somewhere that is not a web address");
      target = next;
      continue;
    }
    const body = await guarded(() => readBody(res, BODY_LIMIT));
    return { status: res.status, body, ms: Math.max(0, Date.now() - started) };
  }
  throw new Unavailable("the page redirects too many times");
}

// Kinds ------------------------------------------------------------------------------

async function website(spec: Extract<WatchCheck, { kind: "website" }>, ports: WatchPorts): Promise<Reading> {
  const problem = urlProblem(spec.url);
  if (problem !== undefined) throw new Unavailable(problem);
  const started = Date.now();
  let res: Response;
  try {
    res = await ports.fetch(spec.url, {
      method: "GET",
      redirect: "follow",
      credentials: "omit",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { "user-agent": "majhi-watch" },
    });
  } catch (err) {
    return { display: describeFailure(err), healthy: false };
  }
  const ms = Math.max(0, Date.now() - started);
  const statusOk = spec.expectStatus === undefined ? res.status < 400 : res.status === spec.expectStatus;
  if (spec.jsonPath !== undefined && spec.jsonPath !== "" && statusOk) {
    let value: number | undefined;
    try {
      value = numberAt(JSON.parse(await readBody(res, 1_000_000)), spec.jsonPath);
    } catch {
      value = undefined;
    }
    if (value === undefined) throw new Unavailable("no number at that path in the answer");
    return { number: value, display: fmt(value), healthy: true, signature: String(value) };
  }
  if (!statusOk) {
    void res.body?.cancel().catch(() => undefined);
    return { number: ms, display: `status ${res.status}`, healthy: false };
  }
  let healthy = true;
  if (spec.keyword !== undefined && spec.keyword !== "") {
    healthy = (await readBody(res, 256 * 1024).catch(() => "")).includes(spec.keyword);
  } else void res.body?.cancel().catch(() => undefined);
  return { number: ms, display: `${res.status} · ${ms} ms`, healthy };
}

async function database(
  spec: Extract<WatchCheck, { kind: "database" }>,
  org: string,
  ports: WatchPorts,
): Promise<Reading> {
  const bad = readOnlySqlProblem(spec.query);
  if (bad !== undefined) throw new Unavailable(bad);
  const conn = await connectionOf(ports, org, spec.connection, ["env"]);
  const url = urlFrom(conn, spec.engine);
  const text = await guarded(() => ports.sql(spec.engine, url, spec.query, SQL_MS));
  const n = numberOfText(text);
  if (n === undefined) throw new Unavailable("the query did not return a number");
  const unit =
    spec.unit === undefined || spec.unit === ""
      ? ""
      : spec.unit.length <= 2 && /^[%$]/.test(spec.unit)
        ? spec.unit
        : ` ${spec.unit}`;
  return {
    number: n,
    display: `${spec.label === undefined || spec.label === "" ? "" : `${spec.label} `}${fmt(n)}${unit}`,
    healthy: true,
    signature: String(n),
  };
}

function infoField(info: string, field: string): number | undefined {
  for (const line of info.split(/\r?\n/)) {
    if (line.startsWith(`${field}:`)) return numberOfText(line.slice(field.length + 1));
  }
  return undefined;
}

function bytesLabel(n: number): string {
  if (n >= 1024 ** 3) return `${fmt(Math.round((n / 1024 ** 3) * 10) / 10)} GB`;
  if (n >= 1024 ** 2) return `${fmt(Math.round(n / 1024 ** 2))} MB`;
  return `${fmt(Math.round(n / 1024))} KB`;
}

async function redis(
  spec: Extract<WatchCheck, { kind: "redis" }>,
  org: string,
  ports: WatchPorts,
): Promise<Reading> {
  const conn = await connectionOf(ports, org, spec.connection, ["env"]);
  const url = urlFrom(conn, "redis");
  if (spec.metric === "keys") {
    const [reply] = await guarded(() => ports.redis(url, [["DBSIZE"]], 8000));
    const n = numberOfText(reply ?? "");
    if (n === undefined) throw new Unavailable("Redis did not answer with a number");
    return { number: n, display: `${fmt(n)} keys`, healthy: true, signature: String(n) };
  }
  const section = spec.metric === "memory_ratio" ? "memory" : spec.metric === "clients" ? "clients" : "all";
  const [info] = await guarded(() => ports.redis(url, [["INFO", section]], 8000));
  const text = info ?? "";
  if (spec.metric === "clients") {
    const n = infoField(text, "connected_clients");
    if (n === undefined) throw new Unavailable("Redis did not report its clients");
    return { number: n, display: `${fmt(n)} clients`, healthy: true, signature: String(n) };
  }
  if (spec.metric === "info") {
    const n = spec.infoField === undefined ? undefined : infoField(text, spec.infoField);
    if (n === undefined) throw new Unavailable("Redis has no number for that field");
    return { number: n, display: `${spec.infoField} ${fmt(n)}`, healthy: true, signature: String(n) };
  }
  const used = infoField(text, "used_memory");
  const max = infoField(text, "maxmemory") ?? 0;
  const limit = max > 0 ? max : infoField(text, "total_system_memory");
  if (used === undefined || limit === undefined || limit <= 0) {
    throw new Unavailable("Redis has no memory limit to compare with");
  }
  const pct = Math.round((used / limit) * 100);
  return { number: pct, display: `${pct}% of ${bytesLabel(limit)}`, healthy: true, signature: String(pct) };
}

/** The only commands a server watch runs, and the only ones a fix may run. Anything else is refused. */
const REMOTE_ALLOWED: readonly RegExp[] = [
  /^df -P \/[A-Za-z0-9_./-]{0,100}$/,
  /^uptime$/,
  /^free -m$/,
  /^sudo -n systemctl restart [a-z0-9@._-]{1,64}$/,
  /^find \/var\/log\/[A-Za-z0-9_./-]{1,100} -type f -name '\*\.log' -mtime \+\d{1,3} -delete$/,
];

export function remoteCommandAllowed(command: string): boolean {
  return !command.includes("..") && REMOTE_ALLOWED.some((re) => re.test(command));
}

/** Runs one of the allowed commands on an SSH host. Refuses anything else before it leaves majhi. */
export async function runAllowed(ports: WatchPorts, alias: string, command: string): Promise<RemoteResult> {
  if (!remoteCommandAllowed(command)) throw new Unavailable("that command is not one majhi runs on a server");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(alias)) throw new Unavailable("the host name is not valid");
  return guarded(() => ports.ssh(alias, command));
}

async function server(
  spec: Extract<WatchCheck, { kind: "server" }>,
  org: string,
  ports: WatchPorts,
): Promise<Reading> {
  const conn = await connectionOf(ports, org, spec.connection, ["ssh"]);
  const alias = conn.fields.alias ?? "";
  if (spec.metric === "disk") {
    const path = spec.path === "" ? "/" : spec.path;
    const res = await runAllowed(ports, alias, `df -P ${path}`);
    const line =
      res.output
        .split("\n")
        .filter((l) => l.trim() !== "")
        .pop() ?? "";
    const pct = /(\d{1,3})%/.exec(line)?.[1];
    if (res.code !== 0 || pct === undefined) throw new Unavailable("the host did not report its disk");
    return { number: Number(pct), display: `disk ${pct}%`, healthy: true, signature: pct };
  }
  if (spec.metric === "cpu") {
    const res = await runAllowed(ports, alias, "uptime");
    const load = /load averages?:\s*([\d.,]+)/i.exec(res.output)?.[1]?.replace(",", ".");
    const n = load === undefined ? undefined : Number(load);
    if (res.code !== 0 || n === undefined || !Number.isFinite(n))
      throw new Unavailable("the host did not report its load");
    return { number: n, display: `load ${fmt(n)}`, healthy: true, signature: String(n) };
  }
  const res = await runAllowed(ports, alias, "free -m");
  const mem = res.output.split("\n").find((l) => /^Mem:/i.test(l));
  const cols = mem?.trim().split(/\s+/).slice(1).map(Number) ?? [];
  const total = cols[0];
  const available =
    cols[5] ?? (cols[2] !== undefined && cols[3] !== undefined ? cols[2] + (cols[3] ?? 0) : undefined);
  if (
    res.code !== 0 ||
    total === undefined ||
    !(total > 0) ||
    available === undefined ||
    Number.isNaN(available)
  ) {
    throw new Unavailable("the host did not report its memory");
  }
  const pct = Math.round(((total - available) / total) * 100);
  return { number: pct, display: `memory ${pct}%`, healthy: true, signature: String(pct) };
}

export const REDIS_KEY = /^[A-Za-z0-9:_.\-{}]{1,200}$/;

async function queue(
  spec: Extract<WatchCheck, { kind: "queue" }>,
  org: string,
  ports: WatchPorts,
): Promise<Reading> {
  const conn = await connectionOf(ports, org, spec.connection, ["env"]);
  if (spec.source === "redis_list") {
    if (spec.key === undefined || !REDIS_KEY.test(spec.key))
      throw new Unavailable("the list name is not valid");
    const [reply] = await guarded(() =>
      ports.redis(urlFrom(conn, "redis"), [["LLEN", spec.key ?? ""]], 8000),
    );
    const n = numberOfText(reply ?? "");
    if (n === undefined) throw new Unavailable("Redis did not answer with a number");
    return { number: n, display: `${fmt(n)} waiting`, healthy: true, signature: String(n) };
  }
  const engine = spec.engine ?? "postgres";
  const query = spec.query ?? "";
  const bad = readOnlySqlProblem(query);
  if (bad !== undefined) throw new Unavailable(bad);
  const text = await guarded(() => ports.sql(engine, urlFrom(conn, engine), query, SQL_MS));
  const n = numberOfText(text);
  if (n === undefined) throw new Unavailable("the query did not return a number");
  return { number: n, display: `${fmt(n)} waiting`, healthy: true, signature: String(n) };
}

/** Tool names that read. A name that starts like a write is refused: a watch only looks. */
const WRITE_TOOL =
  /^(create|delete|update|write|remove|set|send|post|put|run|exec|execute|restart|deploy|kill|start|stop|apply|add|edit|modify|patch|rollback|scale|trigger|invoke|mute|silence|resolve)/i;

async function metric(
  spec: Extract<WatchCheck, { kind: "metric" }>,
  org: string,
  ports: WatchPorts,
): Promise<Reading> {
  if (WRITE_TOOL.test(spec.tool))
    throw new Unavailable("that tool name looks like it changes something. A watch only reads");
  const conn = await connectionOf(ports, org, spec.connection, ["mcp"]);
  void conn;
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(spec.args);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("x");
    args = parsed as Record<string, unknown>;
  } catch {
    throw new Unavailable("the tool's arguments are not a JSON object");
  }
  const answer = await guarded(() => ports.monitor(spec.connection, spec.tool, args));
  const n = numberAt(answer, spec.path);
  if (n === undefined) throw new Unavailable("no number at that path in the answer");
  const unit = spec.unit === undefined || spec.unit === "" ? "" : ` ${spec.unit}`;
  return {
    number: n,
    display: `${spec.label === undefined || spec.label === "" ? "" : `${spec.label} `}${fmt(n)}${unit}`,
    healthy: true,
    signature: String(n),
  };
}

function priceFromLd(blocks: readonly string[]): number | undefined {
  const find = (v: unknown, depth: number): number | undefined => {
    if (depth > 6 || v === null || typeof v !== "object") return undefined;
    if (Array.isArray(v)) {
      for (const item of v) {
        const found = find(item, depth + 1);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    const rec = v as Record<string, unknown>;
    for (const key of ["price", "lowPrice"]) {
      const raw = rec[key];
      if (typeof raw === "number" || typeof raw === "string") {
        const p = parsePrice(String(raw));
        if (p !== undefined) return p.value;
      }
    }
    for (const value of Object.values(rec)) {
      const found = find(value, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (const block of blocks) {
    try {
      const found = find(JSON.parse(block), 0);
      if (found !== undefined) return found;
    } catch {
      // Not JSON: skip it.
    }
  }
  return undefined;
}

async function price(spec: Extract<WatchCheck, { kind: "price" }>, ports: WatchPorts): Promise<Reading> {
  const page = await fetchPublicPage(spec.url, ports);
  if (page.status >= 400) throw new Unavailable(`the page answered ${page.status}`);
  const root = parseHtml(page.body);
  const text = mainText(root);
  if (spec.mode === "text") {
    const node =
      spec.selector === undefined || spec.selector === "" ? undefined : selectFirst(root, spec.selector);
    if (spec.selector !== undefined && spec.selector !== "" && node === undefined)
      throw new Unavailable("nothing on the page matches that selector");
    const body = node === undefined ? text : textOf(node).slice(0, 20_000);
    return { display: "no change", healthy: true, signature: hashText(body), text: body };
  }
  let found: { value: number; symbol: string } | undefined;
  if (spec.selector !== undefined && spec.selector !== "") {
    const node = selectFirst(root, spec.selector);
    if (node === undefined) throw new Unavailable("nothing on the page matches that selector");
    found = parsePrice(textOf(node));
  } else if (spec.pattern !== undefined && spec.pattern !== "") {
    let re: RegExp;
    try {
      re = new RegExp(spec.pattern, "i");
    } catch {
      throw new Unavailable("the pattern is not valid");
    }
    const m = re.exec(text.slice(0, 300_000));
    found = m === null ? undefined : parsePrice(m[1] ?? m[0]);
  } else {
    const meta =
      selectFirst(root, "[itemprop=price]") ??
      selectFirst(root, "meta[property=product:price:amount]") ??
      selectFirst(root, "meta[property=og:price:amount]");
    found = meta === undefined ? undefined : parsePrice(textOf(meta));
    if (found === undefined) {
      const ld = priceFromLd(jsonLd(root));
      if (ld !== undefined) found = { value: ld, symbol: "$" };
    }
  }
  if (found === undefined) throw new Unavailable("no price found. Give a selector or a text pattern");
  return {
    number: found.value,
    display: `${found.symbol}${fmt(found.value)}`,
    healthy: true,
    signature: String(found.value),
    text,
  };
}

/** The size and the number of files of a path print, in words. */
function pathDisplay(print: string): string {
  if (print === "missing") return "missing";
  const [kind, a] = print.split(" ");
  if (kind === "dir") return `${a} ${a === "1" ? "file" : "files"}`;
  return `file, ${fmt(Number(a))} bytes`;
}

async function path(
  spec: Extract<WatchCheck, { kind: "path" }>,
  org: string,
  ports: WatchPorts,
): Promise<Reading> {
  const print = await ports.pathPrint(org, spec.project, spec.path);
  return { display: pathDisplay(print), healthy: true, signature: print };
}

/** One look. Throws Unavailable (a fixed phrase) when it cannot tell; never anything with remote text. */
export async function readWatch(spec: WatchCheck, org: string, ports: WatchPorts): Promise<Reading> {
  switch (spec.kind) {
    case "website":
      return website(spec, ports);
    case "database":
      return database(spec, org, ports);
    case "redis":
      return redis(spec, org, ports);
    case "server":
      return server(spec, org, ports);
    case "queue":
      return queue(spec, org, ports);
    case "price":
      return price(spec, ports);
    case "metric":
      return metric(spec, org, ports);
    case "path":
      return path(spec, org, ports);
    case "custom":
      throw new Unavailable("the captain checks this one");
  }
}
