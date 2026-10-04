import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { errorMessage, UserError } from "../errors.ts";
import { MEMORY_MIGRATIONS } from "../memory/migrations.ts";
import { MIGRATIONS } from "../store/migrations.ts";
import { BUNDLE_FILE, DATA_DIR, Damaged, type Manifest } from "./manifest.ts";

const run = promisify(execFile);

const newest = (list: readonly { id: number }[]) => Math.max(...list.map((m) => m.id));

/** What a restored database must look like before majhi will swap it in. */
interface DbRule {
  rel: string;
  label: string;
  code: number;
  vec: boolean;
}

const RULES: DbRule[] = [
  { rel: "majhi.db", label: "database", code: newest(MIGRATIONS), vec: false },
  { rel: "memory/memory.db", label: "memory", code: newest(MEMORY_MIGRATIONS), vec: true },
];

/** Opens the copy read-only, runs SQLite's integrity check, and compares its migration with this build's. */
function checkDb(file: string, rule: DbRule): string {
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    // memory.db keeps its vectors in sqlite-vec tables, which the integrity check cannot read without the extension.
    if (rule.vec) sqliteVec.load(db);
    const check = db.pragma("integrity_check", { simple: true });
    if (check !== "ok") throw new Damaged(`${rule.label} failed its integrity check: ${String(check)}`);
    const row = db.prepare("SELECT MAX(id) AS id FROM migrations").get() as { id: number | null } | undefined;
    const id = row?.id ?? null;
    if (id === null) throw new Damaged(`${rule.label} holds no majhi data`);
    if (id > rule.code) {
      throw new UserError(
        `The backup's ${rule.label} is from a newer majhi than this one (migration ${id}, this build knows ${rule.code}). Update majhi first.`,
        409,
      );
    }
    return `${rule.label} ok (migration ${id})`;
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new Damaged(`${rule.label} cannot be read: ${errorMessage(err)}`);
  } finally {
    db?.close();
  }
}

/** git without the caller's GIT_* variables, which would override its arguments. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
  return env;
}

/**
 * Rebuilds `data/.git` from the bundle, so a restored folder has the whole config history. Returns
 * a sentence for the report. Does nothing when the backup had no history yet.
 */
export async function buildGit(root: string, manifest: Manifest): Promise<string> {
  if (!manifest.config.bundle) return "no config history yet";
  const clone = await mkdtemp(join(root, "clone-"));
  try {
    await run("git", ["clone", "--quiet", "--no-checkout", join(root, BUNDLE_FILE), clone], {
      env: gitEnv(),
      maxBuffer: 16 * 1024 * 1024,
    });
    // The bundle is only the transport: the restored repository has no remote.
    await run("git", ["-C", clone, "remote", "remove", "origin"], { env: gitEnv() });
    const head = (await run("git", ["-C", clone, "rev-parse", "HEAD"], { env: gitEnv() })).stdout.trim();
    if (manifest.config.head !== null && head !== manifest.config.head) {
      throw new Damaged("the config history is not at the commit the manifest records");
    }
    await rename(join(clone, ".git"), join(root, DATA_DIR, ".git"));
    return `config history at ${head.slice(0, 7)}`;
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new Damaged(`the config history cannot be read: ${errorMessage(err)}`);
  } finally {
    await rm(clone, { recursive: true, force: true });
  }
}

/**
 * Everything that must be true before a restored folder may replace live data: the databases open
 * and pass their integrity check, neither is from a newer migration than this build knows, and the
 * config history rebuilds. Returns one line saying what was checked.
 */
export async function validateStaged(root: string, manifest: Manifest): Promise<string> {
  const notes: string[] = [];
  for (const rule of RULES) {
    const file = join(root, DATA_DIR, rule.rel);
    if (!existsSync(file)) {
      if (rule.rel === "majhi.db") throw new Damaged("it holds no majhi.db");
      continue;
    }
    notes.push(checkDb(file, rule));
  }
  notes.push(await buildGit(root, manifest));
  notes.push(`${manifest.files.length} files match their checksums`);
  return notes.join(", ");
}
