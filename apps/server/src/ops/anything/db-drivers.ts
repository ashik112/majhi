import { type MongoCommand, numberAtPath, parseMongoCommand } from "@majhi/shared";
import { MongoClient } from "mongodb";
import { createConnection } from "mysql2/promise";
import pg from "pg";
import { Unavailable } from "./checks.ts";

/**
 * The database clients of the watch checks. They are Node drivers bundled with the server, so no database
 * program has to exist on the machine. The caller has already checked the statement; each session is also
 * read-only on the server's side. An error from a driver can carry an address or a password, so it is
 * replaced by a fixed phrase before it leaves this file.
 */

const CONNECT_MS = 10_000;
const MAX_ROWS = 1000;

const REFUSED = "the database refused or did not answer";

type TlsMode = "off" | "prefer" | "require" | "verify";

/** psql's sslmode words (and the MySQL ones). `require` encrypts without checking the certificate, like psql does. */
function tlsMode(u: URL): TlsMode {
  const raw = (u.searchParams.get("sslmode") ?? u.searchParams.get("ssl-mode") ?? "").toLowerCase();
  if (raw === "disable" || raw === "allow" || raw === "disabled") return "off";
  if (raw === "require" || raw === "required") return "require";
  if (raw === "verify-full" || raw === "verify-ca" || raw === "verify_identity" || raw === "verify_ca") {
    return "verify";
  }
  return "prefer";
}

function tlsOptions(mode: TlsMode): false | { rejectUnauthorized: boolean } {
  if (mode === "off") return false;
  return { rejectUnauthorized: mode === "verify" };
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function rowsText(rows: readonly (readonly unknown[])[]): string {
  return rows
    .slice(0, MAX_ROWS)
    .map((r) => r.map(cell).join("|"))
    .join("\n");
}

/** The user and password of a URL, left out when empty. */
function credentials(u: URL): { user?: string; password?: string } {
  const user = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  return { ...(user === "" ? {} : { user }), ...(password === "" ? {} : { password }) };
}

function database(u: URL): { database?: string } {
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  return database === "" ? {} : { database };
}

// Postgres ------------------------------------------------------------------------------

async function postgresOnce(
  u: URL,
  query: string,
  timeoutMs: number,
  ssl: false | { rejectUnauthorized: boolean },
): Promise<string> {
  const statementMs = Math.min(timeoutMs, 30_000);
  const client = new pg.Client({
    host: u.hostname,
    port: u.port === "" ? 5432 : Number(u.port),
    ...credentials(u),
    ...database(u),
    ssl,
    connectionTimeoutMillis: CONNECT_MS,
    statement_timeout: statementMs,
    query_timeout: timeoutMs,
    application_name: "majhi-watch",
    options: "-c default_transaction_read_only=on",
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    const res = await client.query({ text: query, rowMode: "array" });
    await client.query("ROLLBACK");
    return rowsText(Array.isArray(res) ? (res[res.length - 1]?.rows ?? []) : res.rows).trim();
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function runPostgres(u: URL, query: string, timeoutMs: number): Promise<string> {
  const mode = tlsMode(u);
  if (mode !== "prefer") return postgresOnce(u, query, timeoutMs, tlsOptions(mode));
  // psql's default: encrypt when the server can, else talk plain.
  try {
    return await postgresOnce(u, query, timeoutMs, tlsOptions("prefer"));
  } catch (err) {
    if (/does not support SSL|ssl/i.test(err instanceof Error ? err.message : "")) {
      return postgresOnce(u, query, timeoutMs, false);
    }
    throw err;
  }
}

// MySQL ---------------------------------------------------------------------------------

async function mysqlOnce(
  u: URL,
  query: string,
  timeoutMs: number,
  ssl: false | { rejectUnauthorized: boolean },
): Promise<string> {
  const conn = await createConnection({
    host: u.hostname,
    port: u.port === "" ? 3306 : Number(u.port),
    ...credentials(u),
    ...database(u),
    ...(ssl === false ? {} : { ssl }),
    connectTimeout: CONNECT_MS,
    multipleStatements: false,
  });
  try {
    await conn.query("SET SESSION TRANSACTION READ ONLY");
    await conn.query("START TRANSACTION READ ONLY");
    const [rows] = await conn.query({ sql: query, rowsAsArray: true, timeout: timeoutMs });
    await conn.query("ROLLBACK");
    return Array.isArray(rows) ? rowsText(rows as unknown[][]).trim() : "";
  } finally {
    await conn.end().catch(() => undefined);
  }
}

export async function runMysql(u: URL, query: string, timeoutMs: number): Promise<string> {
  const mode = tlsMode(u);
  if (mode !== "prefer") return mysqlOnce(u, query, timeoutMs, tlsOptions(mode));
  try {
    return await mysqlOnce(u, query, timeoutMs, tlsOptions("prefer"));
  } catch (err) {
    if ((err as { code?: unknown }).code === "HANDSHAKE_NO_SSL_SUPPORT") {
      return mysqlOnce(u, query, timeoutMs, false);
    }
    throw err;
  }
}

// MongoDB -------------------------------------------------------------------------------

/** The little of a MongoDB database a read command needs. The real driver's `Db` fits; tests pass a fake. */
export interface MongoReader {
  command(cmd: Record<string, unknown>): Promise<unknown>;
  collection(name: string): {
    countDocuments(filter: object, options: { maxTimeMS: number }): Promise<number>;
  };
}

/** Runs one parsed read command and returns its number as text. */
export async function readMongo(db: MongoReader, cmd: MongoCommand, timeoutMs: number): Promise<string> {
  let answer: unknown;
  switch (cmd.command) {
    case "count":
      return String(
        await db.collection(cmd.collection ?? "").countDocuments(cmd.query ?? {}, { maxTimeMS: timeoutMs }),
      );
    case "dbStats":
      answer = await db.command({ dbStats: 1, maxTimeMS: timeoutMs });
      break;
    case "collStats":
      answer = await db.command({ collStats: cmd.collection, maxTimeMS: timeoutMs });
      break;
    case "serverStatus":
      answer = await db.command({ serverStatus: 1, maxTimeMS: timeoutMs });
      break;
  }
  const n = numberAtPath(answer, cmd.path ?? "");
  if (n === undefined) throw new Unavailable("there is no number at that path");
  return String(n);
}

export async function runMongo(url: string, text: string, timeoutMs: number): Promise<string> {
  const parsed = parseMongoCommand(text);
  if (!parsed.ok) throw new Unavailable(parsed.problem);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Unavailable("the database URL is not valid");
  }
  if (u.protocol !== "mongodb:" && u.protocol !== "mongodb+srv:") {
    throw new Unavailable("the URL is not a MongoDB address");
  }
  const name = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const client = new MongoClient(url, {
    serverSelectionTimeoutMS: CONNECT_MS,
    connectTimeoutMS: CONNECT_MS,
    socketTimeoutMS: timeoutMs,
    appName: "majhi-watch",
    readPreference: "secondaryPreferred",
  });
  try {
    await client.connect();
    return await readMongo(
      client.db(name === "" ? "admin" : name) as unknown as MongoReader,
      parsed.command,
      Math.min(timeoutMs, 30_000),
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Every error out of a driver becomes one fixed phrase. */
export function refused(err: unknown): Unavailable {
  if (err instanceof Unavailable) return err;
  const code = (err as { code?: unknown }).code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    return new Unavailable("majhi problem: a database driver failed to load in the server.");
  }
  return new Unavailable(REFUSED);
}
