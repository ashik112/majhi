import { execFile } from "node:child_process";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { connect as tlsConnect } from "node:tls";
import { readOnlySqlProblem } from "@majhi/shared";
import { runRemote } from "../../connections/remote.ts";
import { Unavailable, type WatchPorts } from "./checks.ts";
import { isFixStatement } from "./fixes.ts";

/**
 * The real network behind the watch checks. A database is reached through psql or mysql started with an
 * environment built from scratch (PATH, LANG, a throwaway HOME and the connection's own values, never
 * majhi's), in a read-only session, so the secret is never on a command line. Redis is spoken to
 * directly, with the few commands a watch needs. A server is reached through majhi's own SSH, with
 * only the fixed commands of checks.ts.
 */

const MAX_OUT = 64 * 1024;

function runProgram(
  program: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      program,
      args,
      { env, timeout: timeoutMs, maxBuffer: MAX_OUT, encoding: "utf8" },
      (err, stdout) => {
        if (err === null) return resolve(stdout.trim());
        const code = (err as { code?: unknown }).code;
        if (code === "ENOENT") return reject(new Unavailable(`${program} is not installed on this machine`));
        reject(new Unavailable("the database refused or did not answer"));
      },
    );
    child.stdin?.end();
  });
}

function baseEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    LANG: "C.UTF-8",
    HOME: tmpdir(),
  };
}

async function runSql(
  engine: "postgres" | "mysql",
  url: string,
  query: string,
  timeoutMs: number,
): Promise<string> {
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
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (engine === "postgres") {
    if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Unavailable("the URL is not a Postgres address");
    const env: Record<string, string> = {
      ...baseEnv(),
      PGHOST: u.hostname,
      PGPORT: u.port === "" ? "5432" : u.port,
      PGCONNECT_TIMEOUT: "10",
      PGOPTIONS: `-c default_transaction_read_only=on -c statement_timeout=${Math.min(timeoutMs, 30_000)}`,
      PGAPPNAME: "majhi-watch",
    };
    if (user !== "") env.PGUSER = user;
    if (pass !== "") env.PGPASSWORD = pass;
    if (db !== "") env.PGDATABASE = db;
    const mode = u.searchParams.get("sslmode");
    if (mode !== null && /^[a-z-]{1,20}$/.test(mode)) env.PGSSLMODE = mode;
    return runProgram("psql", ["-X", "-A", "-t", "-q", "-c", query], env, timeoutMs);
  }
  if (u.protocol !== "mysql:") throw new Unavailable("the URL is not a MySQL address");
  const env: Record<string, string> = { ...baseEnv() };
  if (pass !== "") env.MYSQL_PWD = pass;
  const args = [
    "-h",
    u.hostname,
    "-P",
    u.port === "" ? "3306" : u.port,
    "--batch",
    "--skip-column-names",
    "--connect-timeout=10",
    "--init-command=SET SESSION TRANSACTION READ ONLY",
  ];
  if (user !== "") args.push("-u", user);
  args.push("-e", query);
  if (db !== "") args.push(db);
  return runProgram("mysql", args, env, timeoutMs);
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
  parts: Pick<WatchPorts, "fetch" | "lookup" | "now" | "connection" | "monitor" | "pathPrint">,
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
