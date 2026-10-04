import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPendingRestore, cancelStaged, JOURNAL_FILE, readPending, readResult, type SwapFs, stageSwap } from "./swap.ts";

let home: string;

function put(rel: string, text: string, base = home): void {
  const file = join(base, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

/** Every file under the home except the staging, rollback and bookkeeping folders, with a hash of its content. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const skip = new Set(["restore-staging", "rollback", JOURNAL_FILE, "restore-result.json"]);
  const visit = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      if (prefix === "" && skip.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) visit(full, `${prefix}${name}/`);
      else out[`${prefix}${name}`] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  visit(home, "");
  return out;
}

function seedLive(): void {
  put("majhi.db", "live-db");
  put("majhi.db-wal", "live-wal");
  put("majhi.db-shm", "live-shm");
  put("memory/memory.db", "live-memory");
  put("memory/notes.txt", "kept: not a database");
  put("secrets.age", "live-secrets");
  put("majhi.yaml", "live: yaml");
  put("agents/a.md", "live agent");
  put("skills/old/SKILL.md", "live skill that the backup does not have");
}

function stageBackup(): string {
  const staged = join(home, "restore-staging", "r1", "data");
  put("majhi.db", "restored-db", staged);
  put("memory/memory.db", "restored-memory", staged);
  put("secrets.age", "restored-secrets", staged);
  put("majhi.yaml", "restored: yaml", staged);
  put("agents/b.md", "restored agent", staged);
  return staged;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "majhi-swap-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("restore swap", () => {
  it("replaces the data, sets the old data aside and drops the old write-ahead log", () => {
    seedLive();
    const staged = stageBackup();
    stageSwap(home, { id: "r1", name: "majhi-daily-1.age", staged, now: new Date() });
    expect(readPending(home)?.state).toBe("staged");

    expect(applyPendingRestore(home)).toBe(true);

    expect(readFileSync(join(home, "majhi.db"), "utf8")).toBe("restored-db");
    expect(existsSync(join(home, "majhi.db-wal"))).toBe(false);
    expect(existsSync(join(home, "majhi.db-shm"))).toBe(false);
    expect(readFileSync(join(home, "memory/memory.db"), "utf8")).toBe("restored-memory");
    // Only the database in memory/ is replaced: other files there stay.
    expect(readFileSync(join(home, "memory/notes.txt"), "utf8")).toBe("kept: not a database");
    expect(readFileSync(join(home, "agents/b.md"), "utf8")).toBe("restored agent");
    expect(existsSync(join(home, "agents/a.md"))).toBe(false);
    // A folder the backup does not have is left alone.
    expect(readFileSync(join(home, "skills/old/SKILL.md"), "utf8")).toContain("live skill");
    // The old data is kept as the rollback.
    expect(readFileSync(join(home, "rollback/r1/majhi.db"), "utf8")).toBe("live-db");
    expect(readFileSync(join(home, "rollback/r1/majhi.db-wal"), "utf8")).toBe("live-wal");
    expect(readFileSync(join(home, "rollback/r1/agents/a.md"), "utf8")).toBe("live agent");
    expect(readResult(home)?.ok).toBe(true);
    expect(readPending(home)).toBeUndefined();
    // Nothing happens twice.
    expect(applyPendingRestore(home)).toBe(false);
  });

  it("leaves the old data exactly as it was when any single step fails", () => {
    seedLive();
    const before = snapshot();
    for (let failAt = 1; failAt <= 14; failAt++) {
      rmSync(join(home, "restore-staging"), { recursive: true, force: true });
      rmSync(join(home, "rollback"), { recursive: true, force: true });
      const staged = stageBackup();
      stageSwap(home, { id: "r1", name: "majhi-daily-1.age", staged, now: new Date() });
      let calls = 0;
      const flaky: SwapFs = {
        rename(from, to) {
          calls++;
          if (calls === failAt) throw new Error("disk went away");
          renameSync(from, to);
        },
      };
      const applied = applyPendingRestore(home, flaky);
      if (calls < failAt) {
        // Fewer steps than this: the swap ran through.
        expect(applied).toBe(true);
        break;
      }
      expect(applied).toBe(false);
      expect(snapshot()).toEqual(before);
      expect(readResult(home)).toMatchObject({ ok: false });
      expect(readPending(home)).toBeUndefined();
    }
  });

  it("puts everything back at the next start when the process died halfway", () => {
    seedLive();
    const before = snapshot();
    // Whatever the step, the process dies there: every later file operation also fails.
    for (let dieAt = 1; dieAt <= 14; dieAt++) {
      rmSync(join(home, "restore-staging"), { recursive: true, force: true });
      rmSync(join(home, "rollback"), { recursive: true, force: true });
      const staged = stageBackup();
      stageSwap(home, { id: "r1", name: "majhi-daily-1.age", staged, now: new Date() });
      let calls = 0;
      const dying: SwapFs = {
        rename(from, to) {
          calls++;
          if (calls >= dieAt) throw new Error("killed");
          renameSync(from, to);
        },
      };
      applyPendingRestore(home, dying);
      if (calls < dieAt) break;
      // The next start sees a journal that never finished and undoes it.
      expect(applyPendingRestore(home)).toBe(false);
      expect(snapshot()).toEqual(before);
      expect(readResult(home)).toMatchObject({ ok: false });
    }
  });

  it("can cancel a staged restore, and not one that began", () => {
    seedLive();
    const staged = stageBackup();
    stageSwap(home, { id: "r1", name: "majhi-daily-1.age", staged, now: new Date() });
    expect(cancelStaged(home)).toBe(true);
    expect(existsSync(join(home, "restore-staging/r1"))).toBe(false);
    expect(readFileSync(join(home, "majhi.db"), "utf8")).toBe("live-db");
    expect(cancelStaged(home)).toBe(false);
  });

  it("keeps only the newest rollbacks", () => {
    seedLive();
    for (const id of ["r1", "r2", "r3"]) {
      const staged = join(home, "restore-staging", id, "data");
      put("majhi.yaml", `from ${id}`, staged);
      stageSwap(home, { id, name: `${id}.age`, staged, now: new Date() });
      applyPendingRestore(home);
    }
    expect(readdirSync(join(home, "rollback")).sort()).toEqual(["r2", "r3"]);
  });
});
