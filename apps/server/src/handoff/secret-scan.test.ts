import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRepo, tempDir, git as testGit } from "../testing/fixtures.ts";
import { describeHit, scanForSecrets } from "./secret-scan.ts";

/** The pre-ship secret scan against real git: big diffs are scanned in full, never refused for size. */

let dir: string;
let cleanup: () => Promise<void>;
let repo: string;

const token = `ghp_${"k3J9m2P7q1".repeat(4)}`;

async function commitFiles(files: Record<string, string>, message = "work"): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  await testGit(repo, "add", ".");
  await testGit(repo, "commit", "--quiet", "-m", message);
}

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  repo = join(dir, "api");
  await makeRepo(repo, { commit: true });
  await testGit(repo, "checkout", "--quiet", "-b", "task/acm-1");
});
afterEach(async () => cleanup());

describe("the secret scan of a branch", () => {
  it("names the file, line and rule, and masks the value, so a block is never unexplained", async () => {
    await commitFiles({
      "src/app.ts": `export const a = 1;\nexport const b = 2;\nconst gh = "${token}";\n`,
    });
    const scan = await scanForSecrets(repo, "main", "task/acm-1");
    if (scan.kind !== "secret") throw new Error("expected a secret");
    expect(scan.hit).toEqual({
      path: "src/app.ts",
      line: 3,
      rule: "github",
      masked: "ghp_[hidden, 44 chars]",
      more: 0,
    });
    const text = describeHit(scan.hit);
    expect(text).toBe("src/app.ts line 3, rule github, value ghp_[hidden, 44 chars]");
    expect(text).not.toContain(token.slice(4));
  });
});
