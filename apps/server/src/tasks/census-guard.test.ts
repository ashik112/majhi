import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../..");

describe("lifecycle census guard", () => {
  it("no old lifecycle field is referenced more often than the baseline", () => {
    // The script resolves symbols through the TypeScript compiler. Going down is fine; refresh the
    // baseline with `pnpm exec tsx scripts/census-lifecycle.ts --write scripts/census-baseline.json`.
    const run = spawnSync("pnpm", ["exec", "tsx", "scripts/census-lifecycle.ts", "--check", "scripts/census-baseline.json"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(run.stderr).not.toContain("census:");
    expect(run.status).toBe(0);
  }, 120_000);
});
