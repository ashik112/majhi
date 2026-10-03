import { execFile } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * The captain's soak test (SPEC 5.18, "No runaway, no loops") runs with every suite, so the
 * background e2e after each merge into main (PRV-72) runs it too. It lives with the server's tests
 * (`apps/server/src/captain/soak.test.ts`), where it drives the real services and the fake agent.
 */
test("the captain's soak test passes", async () => {
  test.setTimeout(120_000);
  const root = join(import.meta.dirname, "..");
  const vitest = join(root, "node_modules", ".bin", "vitest");
  const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
    execFile(
      vitest,
      ["run", "apps/server/src/captain/soak.test.ts", "--testTimeout=60000"],
      { cwd: root, timeout: 110_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === "number" ? err.code : null;
        resolve({ code, out: `${stdout}\n${stderr}` });
      },
    );
  });
  expect(result.code, result.out.slice(-4_000)).toBe(0);
});
