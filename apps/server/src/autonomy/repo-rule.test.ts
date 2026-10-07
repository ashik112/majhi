import { describe, expect, it } from "vitest";
import { blockingWriter, pathsOf, type RepoRuleTask, repoRuleLine } from "./repo-rule.ts";

const task = (id: string, base: string, paths: string[], project = "acme-api"): RepoRuleTask => ({
  id,
  repos: [{ project, base, paths }],
});

describe("paths", () => {
  it("drops leading and trailing slashes and repeats", () => {
    expect(pathsOf(["./src/a.ts", "src/a.ts", "docs/", "README.md"])).toEqual([
      "README.md",
      "docs",
      "src/a.ts",
    ]);
  });
});

describe("repo rule", () => {
  it("refuses with one line when another task already changes the repo on the same base", () => {
    const line = repoRuleLine(
      "ACM-14",
      task("ACM-14", "main", ["src"]),
      [task("ACM-12", "main", ["src"])],
      "It waits.",
    );
    expect(line).toContain("ACM-12");
  });

  it("runs two tasks on different files of the same folder, and waits when they name the same file or a folder holding it", () => {
    const a = task("ACM-12", "main", ["src/auth/login.ts"]);
    expect(blockingWriter(task("ACM-14", "main", ["src/billing/pay.ts"]), [a])).toBeUndefined();
    expect(blockingWriter(task("ACM-14", "main", ["src/auth/login.ts"]), [a])?.task).toBe("ACM-12");
    expect(blockingWriter(task("ACM-14", "main", ["src/auth"]), [a])?.task).toBe("ACM-12");
    expect(blockingWriter(task("ACM-14", "main", ["src/authors.ts"]), [a])).toBeUndefined();
  });

  it("allows tasks whose plans touch different top-level areas", () => {
    expect(
      repoRuleLine(
        "ACM-14",
        task("ACM-14", "main", ["docs"]),
        [task("ACM-12", "main", ["src"])],
        "It waits.",
      ),
    ).toBeUndefined();
  });

  it("lets a task with no plan information run beside another on the same repo", () => {
    expect(blockingWriter(task("ACM-14", "main", []), [task("ACM-12", "main", ["src"])])).toBeUndefined();
    expect(blockingWriter(task("ACM-14", "main", ["docs"]), [task("ACM-12", "main", [])])).toBeUndefined();
  });

  it("allows another base branch or another project", () => {
    expect(
      blockingWriter(task("ACM-14", "release", ["src"]), [task("ACM-12", "main", ["src"])]),
    ).toBeUndefined();
    expect(
      blockingWriter(task("ACM-14", "main", ["src"]), [task("ACM-12", "main", ["src"], "acme-web")]),
    ).toBeUndefined();
  });

  it("matches a new task whose base is not known yet against any base of the project", () => {
    expect(blockingWriter(task("", "", ["src"]), [task("ACM-12", "develop", ["src"])])?.base).toBe("develop");
  });

  it("never blocks a task on itself", () => {
    expect(
      blockingWriter(task("ACM-12", "main", ["src"]), [task("ACM-12", "main", ["src"])]),
    ).toBeUndefined();
  });
});
