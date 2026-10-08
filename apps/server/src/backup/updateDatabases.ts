import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { z } from "zod";
import { applyPendingRestore, readPending, stageSwap } from "./swap.ts";

export const UPDATE_DATABASE_DIR = "update-databases";
const DATABASES = ["majhi.db", "memory/memory.db"] as const;
const SnapshotSchema = z.object({
  version: z.literal(1),
  present: z.record(z.enum(DATABASES), z.boolean()),
});

async function syncFile(file: string): Promise<void> {
  const handle = await open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Called only while the server is stopped; never opens a Store or applies migrations. */
export async function snapshotUpdateDatabases(home: string): Promise<void> {
  if (readPending(home)) throw new Error("Finish or cancel the pending restore before updating majhi.");
  const target = join(home, UPDATE_DATABASE_DIR);
  if (existsSync(target)) throw new Error("The previous update's database recovery is still pending.");
  const stage = await mkdtemp(join(home, ".update-databases-"));
  const present = {} as Record<(typeof DATABASES)[number], boolean>;
  try {
    for (const rel of DATABASES) {
      const file = join(home, rel);
      present[rel] = existsSync(file);
      if (!present[rel]) continue;
      if (!(await lstat(file)).isFile()) throw new Error(`Database path is not a regular file: ${rel}`);
      const dest = join(stage, rel);
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      const db = new Database(file, { readonly: true, fileMustExist: true });
      try {
        await db.backup(dest);
      } finally {
        db.close();
      }
      await syncFile(dest);
    }
    const manifest = join(stage, "snapshot.json");
    await writeFile(manifest, JSON.stringify(SnapshotSchema.parse({ version: 1, present })), { mode: 0o600 });
    await syncFile(manifest);
    await rename(stage, target);
    const dir = await open(home, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Restore the exact pre-start schemas and WAL state before any old server is started. */
export async function restoreUpdateDatabases(home: string): Promise<void> {
  const source = join(home, UPDATE_DATABASE_DIR);
  const snapshot = SnapshotSchema.parse(JSON.parse(await readFile(join(source, "snapshot.json"), "utf8")));
  // Check every source before touching live data. The snapshot is kept for another recovery attempt.
  for (const rel of DATABASES) {
    if (!snapshot.present[rel]) continue;
    const file = join(source, rel);
    if (!(await lstat(file)).isFile()) throw new Error(`Database snapshot is not regular: ${rel}`);
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      if (rel === "memory/memory.db") sqliteVec.load(db);
      if (db.pragma("integrity_check", { simple: true }) !== "ok")
        throw new Error(`Invalid database snapshot: ${rel}`);
    } finally {
      db.close();
    }
  }
  if (readPending(home)) {
    applyPendingRestore(home);
    if (readPending(home)) throw new Error("The interrupted database restore could not be recovered.");
  }
  const root = await mkdtemp(join(home, ".update-restore-"));
  const staged = join(root, "data");
  await mkdir(staged, { mode: 0o700 });
  for (const rel of DATABASES) {
    if (snapshot.present[rel]) {
      await mkdir(dirname(join(staged, rel)), { recursive: true, mode: 0o700 });
      await copyFile(join(source, rel), join(staged, rel));
      await syncFile(join(staged, rel));
    } else {
      for (const suffix of ["", "-wal", "-shm"]) await rm(join(home, `${rel}${suffix}`), { force: true });
    }
  }
  stageSwap(home, { id: `update-${Date.now()}`, name: "pre-update databases", staged, now: new Date() });
  if (!applyPendingRestore(home)) throw new Error("Could not restore the pre-update databases.");
}
