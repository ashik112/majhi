import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * One name for one thing. Each entry is a word the app retired for a kind of thing, with the word
 * that replaced it. A screen that brings the old word back fails here, so the vocabulary cannot
 * drift one string at a time.
 */
const BANNED: readonly { pattern: RegExp; use: string }[] = [
  { pattern: /ready for review/i, use: "Ready to ship (Ship is the kind)" },
  { pattern: /\bdaily limits?\b/i, use: "Budget (Money is the kind)" },
  { pattern: /\b(?:daily|day) caps?\b/i, use: "Budget" },
  { pattern: /keeps things tidy/i, use: "the plain authority sentence (plainAuthorityText)" },
  { pattern: /only when i ask/i, use: "the plain authority sentence" },
  { pattern: /ask me with upkeep/i, use: "the plain authority sentence" },
  { pattern: /\bapprove and open\b/i, use: "Ship" },
  // "Need you" counts decisions and nothing else. Today's agenda also holds dates, follow-ups and findings.
  { pattern: /\bdecisions? waits? for you\b/i, use: "N decisions need you" },
];

/** Files that must match the old wording because it is stored in data: the captain's log lines. */
const STORED_TEXT = new Set(["features/captain/log-model.ts"]);

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The code with comments blanked, so the check reads strings and not the notes beside them. */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\w"'`])\/\/.*$/gm, "$1");
}

const hits = (code: string) => BANNED.filter((b) => b.pattern.test(withoutComments(code)));

describe("web copy keeps one name per thing", () => {
  it("finds a banned word in a string and ignores one in a comment", () => {
    expect(hits('const a = "Ready for review";')).toHaveLength(1);
    expect(hits("// Ready for review\nconst a = 1;")).toHaveLength(0);
    expect(hits("/* a daily limit */ const a = 1;")).toHaveLength(0);
  });

  it("uses none of the retired words in apps/web/src", () => {
    const found: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (STORED_TEXT.has(relative(SRC, file))) continue;
      for (const { pattern, use } of hits(readFileSync(file, "utf8"))) {
        found.push(`${relative(SRC, file)}: ${pattern} (use ${use})`);
      }
    }
    expect(found).toEqual([]);
  });
});
