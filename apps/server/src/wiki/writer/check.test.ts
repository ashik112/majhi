import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommitSha, CommitShaSchema, wikiPageId } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExportReader, hashLines } from "../source.ts";
import { checkCitation, checkPage, verifySource } from "./check.ts";
import type { DraftClaim, DraftPage } from "./draft.ts";

const SHA: CommitSha = CommitShaSchema.parse("a".repeat(40));
const AT = { repo: "api", commit: SHA };

let root: string;
let exported: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wiki-check-"));
  exported = join(root, "src-aaaa");
  await mkdir(join(exported, "src"), { recursive: true });
  await writeFile(
    join(exported, "src", "app.py"),
    "import os\n\ndef pay(order):\n    return charge(order)\n",
  );
  // Outside the export: a secret a symlink or a path must never reach.
  await writeFile(join(root, "secret.txt"), "TOKEN=do-not-read\n");
  await symlink(join(root, "secret.txt"), join(exported, "src", "leak.txt"));
  await symlink(root, join(exported, "linked-dir"));
  await symlink("app.py", join(exported, "src", "alias.py"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const cite = (path: string, start = 1, end = 1) =>
  checkCitation(new ExportReader(exported), { path, lines: [start, end] }, AT);

describe("the source checker", () => {
  it("accepts a path and lines that exist, and stores the hash of exactly those lines", async () => {
    const got = await cite("src/app.py", 3, 4);
    expect(got).toEqual({
      ok: true,
      source: {
        path: "src/app.py",
        lines: [3, 4],
        repo: "api",
        commit: SHA,
        hash: hashLines(["def pay(order):", "    return charge(order)"]),
      },
    });
  });

  it("refuses .., absolute paths and anything that is not a plain relative path", async () => {
    for (const path of [
      "../secret.txt",
      "src/../../secret.txt",
      join(root, "secret.txt"),
      "/etc/passwd",
      "./src/app.py",
      "src\\app.py",
    ]) {
      expect(await cite(path), path).toEqual({ ok: false, reason: "outside-export" });
    }
  });

  it("refuses a symlink that leads out of the export, to a file or to a folder", async () => {
    expect(await cite("src/leak.txt")).toEqual({ ok: false, reason: "outside-export" });
    expect(await cite("linked-dir/secret.txt")).toEqual({ ok: false, reason: "outside-export" });
  });

  it("follows a symlink that stays inside the export", async () => {
    expect(await cite("src/alias.py", 1, 1)).toMatchObject({ ok: true, source: { path: "src/alias.py" } });
  });

  it("flags a missing file, a folder, and lines outside the file", async () => {
    expect(await cite("src/nope.py")).toEqual({ ok: false, reason: "missing-file" });
    expect(await cite("src")).toEqual({ ok: false, reason: "missing-file" });
    expect(await cite("src/app.py", 4, 5)).toEqual({ ok: false, reason: "bad-range" });
    expect(await cite("src/app.py", 0, 2)).toEqual({ ok: false, reason: "bad-range" });
    expect(await cite("src/app.py", 3, 2)).toEqual({ ok: false, reason: "bad-range" });
  });

  it("sees that cited lines changed since the hash was stored", async () => {
    const got = await cite("src/app.py", 4, 4);
    if (!got.ok) throw new Error("expected a source");
    expect(await verifySource(new ExportReader(exported), got.source)).toBe("ok");
    await writeFile(
      join(exported, "src", "app.py"),
      "import os\n\ndef pay(order):\n    return refund(order)\n",
    );
    expect(await verifySource(new ExportReader(exported), got.source)).toBe("text-changed");
  });
});

function draft(claims: DraftClaim[], roles: DraftPage["roles"] = []): DraftPage {
  return {
    id: wikiPageId({ kind: "overview" }),
    kind: "overview",
    org: "acme",
    project: "api",
    commit: SHA,
    title: "Overview",
    summary: ["The API takes payments."],
    claims,
    roles,
    couldNot: [],
  };
}
const claim = (text: string, proven: boolean, citations: DraftClaim["citations"]): DraftClaim => ({
  text,
  proven,
  citations,
  facts: [],
});

describe("checkPage", () => {
  it("drops the claims that do not hold, numbers the rest from 1, and drops the tile of a dropped role", async () => {
    const page = await checkPage(
      draft(
        [
          claim("The API is a Python app.", true, [{ path: "src/app.py", lines: [1, 1] }]),
          claim("It reads the secret.", true, [{ path: "../secret.txt", lines: [1, 1] }]),
          claim("Payments are taken in `pay`.", true, [{ path: "src/app.py", lines: [3, 4] }]),
          claim("It has a cache.", true, [{ path: "src/app.py", lines: [90, 99] }]),
          claim("It sends mail.", true, []),
          claim("It may use a queue.", false, [{ path: "src/missing.py", lines: [1, 2] }]),
        ],
        [
          { role: "backend", where: "src", tech: "Python", claim: 0 },
          { role: "cache", where: "src", tech: "Redis", claim: 3 },
        ],
      ),
      exported,
    );
    expect(page.claims.map((c) => [c.n, c.text, c.proven])).toEqual([
      [1, "The API is a Python app.", true],
      [2, "Payments are taken in `pay`.", true],
      [3, "It may use a queue.", false],
    ]);
    // A guess keeps only the citations that held: none.
    expect(page.claims[2]?.sources).toEqual([]);
    expect(page.dropped.map((d) => [d.text, d.reason])).toEqual([
      ["It reads the secret.", "outside-export"],
      ["It has a cache.", "bad-range"],
      ["It sends mail.", "no-source"],
    ]);
    // The path outside the repo cannot be written down; the lines that were out of range can.
    expect(page.dropped[0]?.cited).toEqual([]);
    expect(page.dropped[1]?.cited).toEqual([{ path: "src/app.py", lines: [90, 99] }]);
    expect(page.roles).toEqual([{ role: "backend", where: "src", tech: "Python", claim: 1 }]);
    expect(page.builtFrom).toEqual({ api: SHA });
    expect(page.body).toContain("The API takes payments.");
    expect(page.body).toContain("It may use a queue. [3] (guessed)");
    expect(page.body).not.toContain("secret");
  });
});
