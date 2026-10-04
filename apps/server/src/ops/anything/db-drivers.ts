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

/**
 * An error out of a driver becomes a fixed phrase that names the cause, chosen by its code, never its
 * text (which can carry an address or a password). The cause is what lets the owner or the captain act.
 */
export function refused(err: unknown): Unavailable {
  if (err instanceof Unavailable) return err;
  const e = err as { code?: unknown; errno?: unknown; codeName?: unknown; name?: unknown };
  const code = typeof e.code === "string" || typeof e.code === "number" ? String(e.code) : "";
  const known: Record<string, string> = {
    ERR_MODULE_NOT_FOUND: "majhi problem: a database driver failed to load in the server.",
    MODULE_NOT_FOUND: "majhi problem: a database driver failed to load in the server.",
    // Postgres SQLSTATE
    "28P01": "the database refused the login: wrong user or password",
    "28000": "the database refused the login: this user may not connect from here (pg_hba or allowed hosts)",
    "3D000": "the database named in the address does not exist",
    "42501": "the login may not read that: grant it SELECT on what the query reads",
    "57014": "the query ran past its time limit",
    "53300": "the database has no free connections",
    // MySQL
    ER_ACCESS_DENIED_ERROR: "the database refused the login: wrong user or password",
    ER_DBACCESS_DENIED_ERROR: "the login may not use that database",
    ER_BAD_DB_ERROR: "the database named in the address does not exist",
    ER_TABLEACCESS_DENIED_ERROR: "the login may not read that table",
    ER_CON_COUNT_ERROR: "the database has no free connections",
    // Network
    ECONNREFUSED: "nothing answered on that host and port: check the address and port",
    ETIMEDOUT:
      "the connection timed out: the database's firewall may not allow majhi's address (on DigitalOcean, add it under Trusted sources)",
    ENOTFOUND: "the host name does not resolve: check the address",
    EAI_AGAIN: "the host name could not be looked up right now",
    ECONNRESET: "the database closed the connection: it may need TLS (sslmode=require)",
    DEPTH_ZERO_SELF_SIGNED_CERT:
      "the database's certificate is not trusted: use sslmode=require, or give its CA",
    SELF_SIGNED_CERT_IN_CHAIN:
      "the database's certificate is not trusted: use sslmode=require, or give its CA",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE:
      "the database's certificate is not trusted: use sslmode=require, or give its CA",
  };
  if (known[code] !== undefined) return new Unavailable(known[code]);
  // MongoDB names its errors.
  if (e.codeName === "AuthenticationFailed" || code === "18") {
    return new Unavailable("the database refused the login: wrong user or password");
  }
  if (e.codeName === "Unauthorized" || code === "13") {
    return new Unavailable("the login may not run that command: give it the read role");
  }
  if (e.name === "MongoServerSelectionError") {
    return new Unavailable(
      "no MongoDB server answered in time: check the address, and that its firewall allows majhi's address",
    );
  }
  // A timeout of the driver's own connect wait has no code.
  if (/timeout|timed out/i.test(String((err as { message?: unknown }).message ?? ""))) {
    return new Unavailable(
      "the connection timed out: the database's firewall may not allow majhi's address (on DigitalOcean, add it under Trusted sources)",
    );
  }
  return new Unavailable(`${REFUSED}${code === "" ? "" : ` (code ${code.slice(0, 20)})`}`);
}
