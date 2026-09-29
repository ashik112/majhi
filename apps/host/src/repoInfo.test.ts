import { describe, expect, it } from "vitest";
import type { ExecFn } from "./remount.ts";
import { commitSubjects, parseDockerRuntime, readRepo } from "./repoInfo.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function gitExec(answers: Record<string, string>, log: string[][] = []): ExecFn {
  return async (_file, args) => {
    log.push([...args]);
    const key = args.join(" ");
    const hit = Object.entries(answers).find(([k]) => key.startsWith(k));
    if (!hit) throw new Error("fatal: bad revision");
    return { stdout: hit[1], stderr: "" };
  };
}
const ctx = (exec: ExecFn) => ({ git: "/usr/bin/git", repo: "/repo", env: {}, exec });

describe("readRepo", () => {
  it("reports HEAD and whether the checkout has uncommitted changes", async () => {
    const clean = await readRepo(ctx(gitExec({ "rev-parse HEAD": `${HEAD}\n`, "status --porcelain": "" })));
    expect(clean).toEqual({ commit: HEAD, dirty: false });
    const dirty = await readRepo(ctx(gitExec({ "rev-parse HEAD": HEAD, "status --porcelain": " M a.ts\n" })));
    expect(dirty).toEqual({ commit: HEAD, dirty: true });
  });

  it("is undefined when git fails or prints something else", async () => {
    expect(await readRepo(ctx(gitExec({})))).toBeUndefined();
    expect(await readRepo(ctx(gitExec({ "rev-parse HEAD": "not a commit" })))).toBeUndefined();
  });
});

describe("commitSubjects", () => {
  it("runs git log from the running commit to HEAD, at most 20", async () => {
    const seen: string[][] = [];
    const out = await commitSubjects(ctx(gitExec({ log: "feat: two\nfix: one\n" }, seen)), "abcdef1");
    expect(out).toEqual(["feat: two", "fix: one"]);
    expect(seen[0]).toEqual(["log", "--format=%s", "abcdef1..HEAD", "-n", "20"]);
  });

  it("refuses anything that is not a commit id, so an argument cannot be injected", async () => {
    const seen: string[][] = [];
    expect(await commitSubjects(ctx(gitExec({ log: "x" }, seen)), "--output=/etc/passwd")).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("is empty when the commit is not in this checkout", async () => {
    expect(await commitSubjects(ctx(gitExec({})), "abcdef1")).toEqual([]);
  });
});

describe("parseDockerRuntime", () => {
  it("names OrbStack and Docker Desktop from docker's operating system", () => {
    expect(parseDockerRuntime("OrbStack\n")).toBe("orbstack");
    expect(parseDockerRuntime("Docker Desktop")).toBe("docker-desktop");
    expect(parseDockerRuntime("Ubuntu 24.04")).toBe("docker");
  });
});
