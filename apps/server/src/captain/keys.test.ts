import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { CaptainRepo } from "./repo.ts";

/**
 * G1: every captain action is keyed by the state it acts on, and a repeat with the same key does
 * nothing. A ship (task, heads, bases), an answer (card) and a tell (task, the lead's last turn) each
 * take their key in one insert; a store reopened (a restart) still holds it. Results are typed.
 */

const DAY = "2026-10-03";
const NOW = new Date(`${DAY}T12:00:00.000Z`);

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A database file the test can close and open again, as a restart does. */
async function dbFile(): Promise<{ open: () => CaptainRepo }> {
  const dir = await mkdtemp(join(tmpdir(), "majhi-keys-"));
  dirs.push(dir);
  const file = join(dir, "majhi.db");
  return {
    open: () => {
      const store = new Store(file);
      stores.push(store);
      return new CaptainRepo(store.raw);
    },
  };
}

describe("the key claim", () => {
  it("lets two connections to one database race: one wins on the unique key", async () => {
    const db = await dbFile();
    const a = db.open();
    const b = db.open();
    const results = [
      a.claimKey("answer", "answer:ACM-1:i1", "ACM-1", NOW.toISOString()),
      b.claimKey("answer", "answer:ACM-1:i1", "ACM-1", NOW.toISOString()),
    ];
    expect(results.filter((r) => r === "taken")).toHaveLength(1);
  });
});
