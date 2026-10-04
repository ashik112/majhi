import { describe, expect, it } from "vitest";
import { areaOf, areasOf, blockingWriter, type RepoRuleTask, repoRuleLine } from "./repo-rule.ts";

const task = (id: string, base: string, areas: string[], project = "acme-api"): RepoRuleTask => ({
  id,
  repos: [{ project, base, areas }],
});

describe("areas", () => {
  it("takes the top-level folder, or . for a file at the root", () => {
    expect(areaOf("src/auth/login.ts")).toBe("src");
    expect(areaOf("package.json")).toBe(".");
    expect(areasOf(["src/a.ts", "src/b.ts", "docs/x.md", "README.md"])).toEqual([".", "docs", "src"]);
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
    expect(line).toBe("Not starting ACM-14: ACM-12 is already changing acme-api on main. It waits.");
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
