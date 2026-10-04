import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changeBase } from "../git/since-start.ts";
import { makeRepo, tempDir, git as testGit } from "../testing/fixtures.ts";
import { scanForSecrets, skippedByPattern } from "./secret-scan.ts";

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

const lines = (n: number, prefix = "entry") =>
  `${Array.from({ length: n }, (_, i) => `${prefix}-${i}: resolved`).join("\n")}\n`;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  repo = join(dir, "api");
  await makeRepo(repo, { commit: true });
  await testGit(repo, "checkout", "--quiet", "-b", "task/acm-1");
});
afterEach(async () => cleanup());

describe("the secret scan of a branch", () => {
  it("scans a large diff with a lockfile and passes it", async () => {
    await commitFiles({
      "pnpm-lock.yaml": lines(60_000, "pkg"),
      "src/a.ts": "export const a = 1;\n",
    });
    expect(await scanForSecrets(repo, "main", "task/acm-1")).toEqual({ kind: "clean", files: 1, skipped: 1 });
  });

  it("does not look inside a lockfile, so a token there is not the owner's to fix", async () => {
    await commitFiles({ "package-lock.json": `{"integrity": "${token}"}\n` });
    expect((await scanForSecrets(repo, "main", "task/acm-1")).kind).toBe("clean");
  });

  it("still catches a secret in the last file of a big diff", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) files[`src/f${String(i).padStart(2, "0")}.ts`] = lines(200);
    files["src/f39.ts"] = `${lines(200)}const token = "${token}";\n`;
    await commitFiles(files);
    expect(await scanForSecrets(repo, "main", "task/acm-1")).toEqual({ kind: "secret", path: "src/f39.ts" });
  });

  it("catches a secret in a file whose name has spaces and in a nested folder", async () => {
    await commitFiles({ "config/my app/.env.local": `API_TOKEN=${token}\n` });
    expect(await scanForSecrets(repo, "main", "task/acm-1")).toEqual({
      kind: "secret",
      path: "config/my app/.env.local",
    });
  });

  it("stops only past its ceiling and names the biggest files", async () => {
    await commitFiles({ "src/big.ts": lines(500), "src/mid.ts": lines(300), "src/small.ts": lines(5) });
    const scan = await scanForSecrets(repo, "main", "task/acm-1", { files: 100, lines: 700 });
    expect(scan).toEqual({
      kind: "too-large",
      why: "3 files and 805 added lines; the biggest are src/big.ts (500 lines), src/mid.ts (300 lines), src/small.ts (5 lines)",
    });
  });

  it("leaves lockfiles, generated files and binaries out by pattern", () => {
    for (const path of ["pnpm-lock.yaml", "a/b/Cargo.lock", "dist/app.js", "x.min.js", "logo.png", "go.sum"])
      expect(skippedByPattern(path)).toBe(true);
    for (const path of ["src/app.ts", ".env", "docs/lock.md", "build.sh"])
      expect(skippedByPattern(path)).toBe(false);
  });
});

describe("what a merge request carries", () => {
  it("measures from the merge base, not from an old start commit, once main was merged in", async () => {
    const start = await testGit(repo, "rev-parse", "HEAD");
    await testGit(repo, "checkout", "--quiet", "main");
    await commitFiles(
      { "vendor-sync/big.ts": lines(300), "ops/deploy.env": `TOKEN=${token}\n` },
      "main moves",
    );
    await testGit(repo, "checkout", "--quiet", "task/acm-1");
    await commitFiles({ "src/mine.ts": "export const mine = 1;\n" });
    await testGit(repo, "merge", "--quiet", "--no-edit", "main");

    const task = { source: repo, base: "main", branch: "task/acm-1", startCommit: start };
    const old = await changeBase(repo, task, "refs/heads/task/acm-1");
    expect(old.commit).toBe(start);
    const now = await changeBase(repo, task, "refs/heads/task/acm-1", { mergeBase: true });
    expect(now.commit).toBe(await testGit(repo, "rev-parse", "main"));
    expect(await scanForSecrets(repo, now.commit, "task/acm-1")).toEqual({
      kind: "clean",
      files: 1,
      skipped: 0,
    });
  });
});
