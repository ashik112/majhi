import { describe, expect, it } from "vitest";
import { GUARD_CONFIG } from "./gitGuard.ts";
import type { ExecFn } from "./remount.ts";
import { commitSubjects } from "./repoInfo.ts";

function gitExec(answers: Record<string, string>, log: string[][] = []): ExecFn {
  return async (_file, args) => {
    // Every call runs with the helper's guards; what follows them is the command.
    expect(args.slice(0, GUARD_CONFIG.length)).toEqual(GUARD_CONFIG);
    log.push(args.slice(GUARD_CONFIG.length));
    const key = args.slice(GUARD_CONFIG.length).join(" ");
    const hit = Object.entries(answers).find(([k]) => key.startsWith(k));
    if (!hit) throw new Error("fatal: bad revision");
    return { stdout: hit[1], stderr: "" };
  };
}
const ctx = (exec: ExecFn) => ({ git: "/usr/bin/git", repo: "/repo", env: {}, exec });

describe("commitSubjects", () => {
  it("refuses anything that is not a commit id, so an argument cannot be injected", async () => {
    const seen: string[][] = [];
    expect(await commitSubjects(ctx(gitExec({ log: "x" }, seen)), "--output=/etc/passwd")).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("is empty when the commit is not in this checkout", async () => {
    expect(await commitSubjects(ctx(gitExec({})), "abcdef1")).toEqual([]);
  });
});
