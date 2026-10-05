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
  it("still catches a secret in the last file of a big diff", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) files[`src/f${String(i).padStart(2, "0")}.ts`] = lines(200);
    files["src/f39.ts"] = `${lines(200)}const token = "${token}";\n`;
    await commitFiles(files);
    const scan = await scanForSecrets(repo, "main", "task/acm-1");
    expect(scan.kind === "secret" && describeHit(scan.hit)).toBe(
      "src/f39.ts line 201, rule github, value ghp_[hidden, 44 chars]",
    );
  });

  it("catches a secret in a file whose name has spaces and in a nested folder", async () => {
    await commitFiles({ "config/my app/.env.local": `API_TOKEN=${token}\n` });
    const scan = await scanForSecrets(repo, "main", "task/acm-1");
    expect(scan).toMatchObject({ kind: "secret", hit: { path: "config/my app/.env.local", line: 1 } });
  });

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

  it("reads only what the branch adds: a secret removed or left in old lines is not a block", async () => {
    await commitFiles({ "src/old.ts": `const gh = "${token}";\n` });
    await testGit(repo, "checkout", "--quiet", "-b", "task/acm-2");
    await commitFiles({ "src/new.ts": "export const x = 1;\n" });
    expect((await scanForSecrets(repo, "task/acm-1", "task/acm-2")).kind).toBe("clean");
  });

  it("counts the line from the hunk, not from the start of the added text", async () => {
    await commitFiles({ "src/a.ts": `${lines(10)}` });
    await testGit(repo, "checkout", "--quiet", "-b", "task/acm-3");
    await commitFiles({ "src/a.ts": `${lines(10)}// token ${token}\n` });
    const scan = await scanForSecrets(repo, "task/acm-1", "task/acm-3");
    expect(scan).toMatchObject({ kind: "secret", hit: { path: "src/a.ts", line: 11 } });
  });

});
