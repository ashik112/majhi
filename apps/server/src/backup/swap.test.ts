import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyPendingRestore,
  JOURNAL_FILE,
  readPending,
  readResult,
  type SwapFs,
  stageSwap,
} from "./swap.ts";

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
});
