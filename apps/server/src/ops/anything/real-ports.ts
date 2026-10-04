import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { readOnlySqlProblem } from "@majhi/shared";
import { runRemote } from "../../connections/remote.ts";
import { type DbEngine, Unavailable, type WatchPorts } from "./checks.ts";
import { refused, runMongo, runMysql, runPostgres } from "./db-drivers.ts";
import { isFixStatement } from "./fixes.ts";

/**
 * The real network behind the watch checks. A database is reached with a Node driver bundled with the
 * server (pg, mysql2, mongodb), in a read-only session, with only the connection's own URL (never majhi's
 * environment); nothing is ever put on a command line. Redis is spoken to
 * directly, with the few commands a watch needs. A server is reached through majhi's own SSH, with
 * only the fixed commands of checks.ts.
 */

async function runSql(engine: DbEngine, url: string, query: string, timeoutMs: number): Promise<string> {
  if (engine === "mongodb") return runMongo(url, query, timeoutMs);
  // The statement is checked again here: a read, or exactly one of the fixed fix statements.
  if (readOnlySqlProblem(query) !== undefined && !isFixStatement(query)) {
    throw new Unavailable("only reads and the fixed fixes run");
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Unavailable("the database URL is not valid");
  }
  try {
    if (engine === "postgres") {
      if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Unavailable("the URL is not a Postgres address");
      return await runPostgres(u, query, timeoutMs);
    }
    if (u.protocol !== "mysql:") throw new Unavailable("the URL is not a MySQL address");
    return await runMysql(u, query, timeoutMs);
  } catch (err) {
    throw refused(err);
  }
}

// Redis ---------------------------------------------------------------------------------

const REDIS_ALLOWED = new Set(["INFO", "DBSIZE", "LLEN", "PING"]);

function encode(cmd: readonly string[]): string {
  return `*${cmd.length}\r\n${cmd.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join("")}`;
}

/** Reads `count` replies from a buffer. Returns the texts and how many bytes it used, or undefined when more is needed. */
function parseReplies(buf: Buffer, count: number): { texts: string[]; error?: string } | undefined {
  let pos = 0;
  const texts: string[] = [];
  const line = (): string | undefined => {
    const end = buf.indexOf("\r\n", pos);
    if (end === -1) return undefined;
    const s = buf.toString("utf8", pos, end);
    pos = end + 2;
    return s;
  };
  const one = (): string | undefined | { error: string } => {
    const head = line();
    if (head === undefined) return undefined;
    const kind = head[0];
    const rest = head.slice(1);
    if (kind === "+" || kind === ":") return rest;
    if (kind === "-") return { error: rest };
    if (kind === "$") {
      const len = Number(rest);
      if (len < 0) return "";
      if (buf.length < pos + len + 2) return undefined;
      const s = buf.toString("utf8", pos, pos + len);
      pos += len + 2;
      return s;
    }
    if (kind === "*") {
      const n = Number(rest);
      const parts: string[] = [];
      for (let i = 0; i < n; i += 1) {
        const item = one();
        if (item === undefined) return undefined;
        if (typeof item === "object") return item;
        parts.push(item);
      }
      return parts.join("\n");
    }
    return { error: "unexpected reply" };
  };
  for (let i = 0; i < count; i += 1) {
    const r = one();
    if (r === undefined) return undefined;
    if (typeof r === "object") return { texts, error: r.error };
    texts.push(r);
  }
  return { texts };
}

function runRedis(url: string, commands: readonly string[][], timeoutMs: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return reject(new Unavailable("the Redis URL is not valid"));
    }
    if (u.protocol !== "redis:" && u.protocol !== "rediss:") {
      return reject(new Unavailable("the URL is not a Redis address"));
    }
    for (const c of commands) {
      if (!REDIS_ALLOWED.has((c[0] ?? "").toUpperCase())) {
        return reject(new Unavailable("only INFO, DBSIZE and LLEN run on Redis"));
      }
    }
    const pre: string[][] = [];
    const user = decodeURIComponent(u.username);
    const pass = decodeURIComponent(u.password);
    if (pass !== "") pre.push(user === "" ? ["AUTH", pass] : ["AUTH", user, pass]);
    const dbn = u.pathname.replace(/^\//, "");
    if (/^\d{1,2}$/.test(dbn)) pre.push(["SELECT", dbn]);
    const all = [...pre, ...commands];
    const port = u.port === "" ? 6379 : Number(u.port);
    const socket =
      u.protocol === "rediss:"
        ? tlsConnect({ host: u.hostname, port, servername: u.hostname })
        : netConnect({ host: u.hostname, port });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (err?: Unavailable, texts?: string[]) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err !== undefined) reject(err);
      else resolve(texts ?? []);
    };
    socket.setTimeout(timeoutMs, () => finish(new Unavailable("no answer in time")));
    socket.once("error", () => finish(new Unavailable("connection dropped")));
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 4 * 1024 * 1024) return finish(new Unavailable("the answer is too large"));
      const parsed = parseReplies(buf, all.length);
      if (parsed === undefined) return;
      if (parsed.error !== undefined) return finish(new Unavailable("Redis refused the command"));
      finish(undefined, parsed.texts.slice(pre.length));
    });
    const send = () => socket.write(all.map(encode).join(""));
    if (u.protocol === "rediss:") socket.once("secureConnect", send);
    else socket.once("connect", send);
  });
}

/** The real ports. `connection` and `monitor` come from the connections of the workspace. */
export function realWatchPorts(
  parts: Pick<WatchPorts, "fetch" | "lookup" | "now" | "connection" | "monitor" | "pathPrint"> &
    Partial<Pick<WatchPorts, "checkout" | "host">>,
): WatchPorts {
  return {
    ...parts,
    sql: runSql,
    redis: runRedis,
    ssh: async (alias, command) => {
      const res = await runRemote(alias, command);
      return { code: res.code, output: res.output };
    },
  };
}
