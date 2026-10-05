import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeLeftoverFolders } from "./removed-folders.ts";

function home(): string {
  return mkdtempSync(join(tmpdir(), "majhi-home-"));
}
const put = (path: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
};

describe("removeLeftoverFolders", () => {
  it("removes e2e and business/kb and nothing else", async () => {
    const h = home();
    put(join(h, "e2e", "runs", "a.json"));
    put(join(h, "business", "kb", "note.md"));
    put(join(h, "business", "keep.md"));
    put(join(h, "majhi.db"));
    put(join(h, "tools", "acme", "bin", "doctl"));
    put(join(h, "accounts", "e2e-notes", "a"));
    put(join(h, "memory", "e2e", "a"));
    const lines: string[] = [];
    const out = await removeLeftoverFolders(h, (l) => lines.push(l));
    expect(out).toEqual([
      { folder: "e2e", removed: true },
      { folder: "business/kb", removed: true },
    ]);
    expect(existsSync(join(h, "e2e"))).toBe(false);
    expect(existsSync(join(h, "business", "kb"))).toBe(false);
    for (const kept of [
      "business/keep.md",
      "majhi.db",
      "tools/acme/bin/doctl",
      "accounts/e2e-notes/a",
      "memory/e2e/a",
    ]) {
      expect(existsSync(join(h, kept))).toBe(true);
    }
  });

  it("never follows a link out of the home", async () => {
    const h = home();
    const outside = home();
    put(join(outside, "precious.txt"));
    symlinkSync(outside, join(h, "e2e"));
    const out = await removeLeftoverFolders(h, () => undefined);
    expect(out).toEqual([{ folder: "e2e", removed: false, kept: "it is not a plain folder" }]);
    expect(existsSync(join(outside, "precious.txt"))).toBe(true);
  });
});
