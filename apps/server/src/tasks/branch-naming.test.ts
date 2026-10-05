import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRepo } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { guardMounts } from "../runs/launch.ts";
import {
  branchName,
  detectBranchStyle,
  detectCommitStyle,
  forgetRepoStyles,
  freeBranch,
  inferBranchType,
  readRepoStyle,
  shortSlug,
  slugify,
  styleOptions,
  titleFor,
  typeOfBranch,
} from "./branch-naming.ts";
import { targetRefusal } from "./ship-plan.ts";
import { unshippedCommits } from "./shipped.ts";

describe("the type of a branch, from the title", () => {
  it.each([
    ["Fix the login redirect", "fix"],
    ["Dockerfile fails to fetch archive sources", "fix"],
    ["The upload is broken on Safari", "fix"],
    ["Crash on empty cart", "fix"],
    ["Add retry when the upload fails", "feat"],
    ["Add a voice endpoint test", "feat"],
    ["Bump axios to 1.20", "chore"],
    ["axios 1.20 is out", "chore"],
    ["Upgrade node to 24", "chore"],
    ["Ignore build output in git", "chore"],
    ["Update the README", "chore"],
    ["Document the webhook payload", "docs"],
    ["Readme for the host helper", "docs"],
    ["Refactor the room store", "refactor"],
    ["Move the login off staging", "refactor"],
    ["Rename Task to Job", "refactor"],
    ["Test the merge queue", "test"],
    ["Make the board faster", "perf"],
    ["Slow dashboard on large orgs", "perf"],
    ["Pipeline timeouts", "ci"],
    ["Dockerfile for the runner", "build"],
    ["Show the usage per org", "feat"],
    ["!!!", "feat"],
    ["feature(api): voice input", "feat"],
    ["perf(api): cache the list", "perf"],
  ])("%s is %s", (title, type) => {
    expect(inferBranchType(title)).toBe(type);
  });
});

describe("slugs", () => {
  it("is lowercase ascii, without links, mentions or a type prefix", () => {
    expect(slugify("@builder Add a Health endpoint to api https://e.com/x")).toBe(
      "add-a-health-endpoint-to-api",
    );
    expect(slugify("Café déjà vu: Zoë's crème")).toBe("cafe-deja-vu-zoe-s-creme");
    expect(slugify("fix(api): login redirect")).toBe("login-redirect");
    expect(slugify("Note: keep this")).toBe("note-keep-this");
  });

  it("cuts at 40 characters between words", () => {
    const slug = shortSlug("implement the very long feature name that goes on and on forever");
    expect(slug).toBe("implement-the-very-long-feature-name");
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it("cuts a single long word", () => {
    expect(shortSlug("a".repeat(60))).toBe("a".repeat(40));
  });
});

describe("branch names", () => {
  it("is <type>/<id>-<slug> by default", () => {
    expect(branchName({ id: "PYZ-14", title: "Voice endpoint test", type: "feat" })).toBe(
      "feat/pyz-14-voice-endpoint-test",
    );
    expect(branchName({ id: "IDE-12", title: "axios 1.20 is out", type: "chore" })).toBe(
      "chore/ide-12-axios-1-20-is-out",
    );
  });

  it("has no dangling dash for a title of only symbols", () => {
    expect(branchName({ id: "LOCAL-2", title: "!!!", type: "fix" })).toBe("fix/local-2");
  });

  it("follows the repo's words for a type and an owner's pattern", () => {
    expect(
      branchName({ id: "ACM-1", title: "Add login", type: "feat", typeWords: { feat: "feature" } }),
    ).toBe("feature/acm-1-add-login");
    expect(branchName({ id: "ACM-1", title: "Add login", type: "feat", pattern: "{ID}/{slug}" })).toBe(
      "ACM-1/add-login",
    );
    expect(branchName({ id: "ACM-1", title: "Add login", type: "fix", pattern: "dev/{type}-{id}" })).toBe(
      "dev/fix-acm-1",
    );
  });

  it("falls back to the default when a pattern would give a branch git or a run cannot use", () => {
    expect(branchName({ id: "ACM-1", title: "Add login", type: "feat", pattern: "{id}-{slug}" })).toBe(
      "feat/acm-1-add-login",
    );
    expect(branchName({ id: "ACM-1", title: "Add login", type: "feat", pattern: "../{id}" })).toBe(
      "feat/acm-1-add-login",
    );
  });

  it("numbers a name that is taken", async () => {
    const taken = new Set(["feat/acm-1-x", "feat/acm-1-x-2"]);
    expect(await freeBranch("feat/acm-1-x", async (b) => taken.has(b))).toBe("feat/acm-1-x-3");
    expect(await freeBranch("feat/acm-1-y", async (b) => taken.has(b))).toBe("feat/acm-1-y");
  });
});

describe("what a repo's branches show", () => {
  it("follows a repo that writes feature/ and bugfix/", () => {
    const style = detectBranchStyle([
      "main",
      "feature/login",
      "feature/search",
      "feature/export",
      "bugfix/crash",
      "develop",
    ]);
    expect(style).toEqual({ kind: "typed", words: { feat: "feature", fix: "bugfix" } });
    expect(branchName({ id: "ACM-1", title: "Add login", type: "feat", ...styleOptions(style) })).toBe(
      "feature/acm-1-add-login",
    );
    expect(branchName({ id: "ACM-2", title: "Fix crash", type: "fix", ...styleOptions(style) })).toBe(
      "bugfix/acm-2-fix-crash",
    );
    expect(branchName({ id: "ACM-3", title: "Bump axios", type: "chore", ...styleOptions(style) })).toBe(
      "chore/acm-3-bump-axios",
    );
  });

  it("follows a repo that names branches by issue key", () => {
    const style = detectBranchStyle(["main", "ABC-12/login", "ABC-13/search", "ABC-14-export", "dev"]);
    expect(style).toEqual({ kind: "key", upper: true });
    expect(branchName({ id: "ABC-15", title: "Add login", type: "feat", ...styleOptions(style) })).toBe(
      "ABC-15/add-login",
    );
  });

  it("shows nothing from a few branches, from majhi's own, or from bots", () => {
    expect(detectBranchStyle(["main", "feature/a", "feature/b"])).toEqual({ kind: "default" });
    expect(
      detectBranchStyle(["task/acm-1-a", "task/acm-2-b", "task/acm-3-c", "dependabot/npm/x", "release/1.2"]),
    ).toEqual({ kind: "default" });
  });

  it("reads the most common word when a repo mixes", () => {
    const style = detectBranchStyle(["feat/a", "feat/b", "feature/c"]);
    expect(style).toEqual({ kind: "typed", words: { feat: "feat" } });
  });
});

describe("what a repo's commits show", () => {
  it("is conventional when most subjects follow it", () => {
    expect(
      detectCommitStyle([
        "feat(api): add x",
        "fix: y",
        "chore(deps): bump z",
        "Update readme",
        "docs: a",
        "Merge branch 'x'",
      ]),
    ).toBe("conventional");
  });

  it("is other when they clearly do not, and unknown with little history", () => {
    expect(detectCommitStyle(["Add x", "Fix y", "Bump z", "Update a", "Remove b", "Rename c"])).toBe("other");
    expect(detectCommitStyle(["Add x", "Fix y"])).toBe("unknown");
  });

  it("titles a merge request in the repo's style", () => {
    const req = { id: "ACM-1", title: "fix: login redirect", type: "fix" as const };
    expect(titleFor(req, "conventional")).toBe("fix(acm-1): login redirect");
    expect(titleFor(req, "other")).toBe("ACM-1: fix: login redirect");
    expect(titleFor({ ...req, title: "Login redirect" }, "unknown")).toBe("ACM-1: Login redirect");
  });
});

describe("a real repo", () => {
  const dirs: string[] = [];
  afterEach(() => {
    forgetRepoStyles();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function repo(branches: string[], subjects: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "majhi-style-"));
    dirs.push(dir);
    const run = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
        cwd: dir,
        stdio: "pipe",
      });
    run("init", "--quiet", "-b", "main");
    for (const s of subjects) run("commit", "--quiet", "--allow-empty", "-m", s);
    for (const b of branches) run("branch", b);
    return dir;
  }

  it("reads local branches and recent commits, once", async () => {
    const dir = repo(
      ["feature/a", "feature/b", "feature/c"],
      ["feat: a", "fix: b", "chore: c", "docs: d", "feat: e"],
    );
    const first = await readRepoStyle(dir, 1_000);
    expect(first).toEqual({
      branches: { kind: "typed", words: { feat: "feature" } },
      commits: "conventional",
    });
    execFileSync("git", ["branch", "-D", "feature/a", "feature/b", "feature/c"], { cwd: dir, stdio: "pipe" });
    expect(await readRepoStyle(dir, 2_000)).toBe(first);
    expect((await readRepoStyle(dir, 1_000 + 11 * 60_000)).branches).toEqual({ kind: "default" });
  });

  it("shows nothing for a folder that is not a repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "majhi-style-"));
    dirs.push(dir);
    expect(await readRepoStyle(dir)).toEqual({ branches: { kind: "default" }, commits: "unknown" });
  });
});

describe("branches that already exist", () => {
  it("leaves task/ branches alone: no type, still guarded", async () => {
    expect(typeOfBranch("task/acm-1-fix-login")).toBeUndefined();
    expect(typeOfBranch("fix/acm-1-fix-login")).toBe("fix");
    expect(typeOfBranch("feature/acm-1-x")).toBe("feat");
    expect(typeOfBranch("main")).toBeUndefined();

    const dir = mkdtempSync(join(tmpdir(), "majhi-guard-"));
    try {
      const paths = async (branch: string, created: boolean) =>
        (await guardMounts(dir, branch, created)).map(
          (m) => `${m.path.slice(dir.length)}${m.readOnly === true ? " ro" : ""}`,
        );
      expect(await paths("task/acm-1-fix-login", false)).toEqual([
        "/refs/heads ro",
        "/refs/heads/task",
        "/refs/remotes ro",
        "/refs/tags ro",
      ]);
      expect(await paths("fix/acm-1-fix-login", true)).toEqual([
        "/refs/heads ro",
        "/refs/heads/fix",
        "/refs/remotes ro",
        "/refs/tags ro",
      ]);
      expect(await paths("feature/acm-1-login", true)).toContain("/refs/heads/feature");
      // A branch the owner named stays writable: only the hooks guard it.
      expect(await paths("dev", false)).toEqual([]);
      expect(await paths("owner/topic", false)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to ship into any task's branch, old or new", async () => {
    const repo = { project: "acme-api", base: "main", branch: "feat/acm-1-x" } as TaskRepo;
    expect(await targetRefusal(repo, "task/acm-2-y", "/tasks")).toContain("is a task branch");
    expect(await targetRefusal(repo, "fix/acm-2-y", "/nonexistent", new Set(["fix/acm-2-y"]))).toContain(
      "is a task branch",
    );
  });

  it("does not count a task's work as shipped because another task's branch stacks on it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "majhi-ship-"));
    try {
      const run = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
          cwd: dir,
          stdio: "pipe",
        });
      run("init", "--quiet", "-b", "main");
      run("commit", "--quiet", "--allow-empty", "-m", "base");
      run("checkout", "--quiet", "-b", "feat/acm-1-a");
      run("commit", "--quiet", "--allow-empty", "-m", "work");
      run("branch", "fix/acm-2-b");
      run("checkout", "--quiet", "main");
      const repo = {
        project: "acme-api",
        source: dir,
        base: "main",
        branch: "feat/acm-1-a",
        createdBranch: true,
      } as TaskRepo;
      expect(await unshippedCommits(repo, new Set(["feat/acm-1-a", "fix/acm-2-b"]))).toBe(1);
      expect(await unshippedCommits(repo, new Set(["feat/acm-1-a"]))).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
