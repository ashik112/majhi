import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { git } from "../git/git.ts";
import { commitBy, commitCheckpoint } from "../runs/checkpoint.ts";
import { migrate } from "../store/migrations.ts";
import { makeCheckout } from "./checkout.ts";
import { HandoffRepo } from "./repo.ts";
import { type CheckSpec, type ExecResult, type HandoffPorts, HandoffService } from "./service.ts";

const result = (code: number, output = ""): ExecResult => ({
  code,
  timedOut: false,
  output,
  log: output,
  ms: 500,
});

/** One task with one repo, a check spec per kind, and an exec that answers by where it runs. */
function world(over: {
  specs: Record<string, CheckSpec>;
  run: (cwd: string, command: string) => ExecResult;
  memory?: string;
}) {
  const db = new Database(":memory:");
  migrate(db);
  const ran: { cwd: string; command: string }[] = [];
  const found: { kind: string; problems: string[] }[] = [];
  const ports: HandoffPorts = {
    task: () => ({
      id: "ACM-1",
      title: "Task",
      brief: "Fix the total.",
      org: "acme",
      status: "review",
      repos: [{ project: "acme-api", worktree: "/work/ACM-1/acme-api" }],
    }),
    heads: async () => "acme-api@aaa111",
    ready: async () => ({ ok: true, evidence: "committed" }),
    commands: () => ({}),
    checkSpec: async (_t, _p, kind) => over.specs[kind],
    mergeBase: async () => "b".repeat(40),
    headCommit: async () => "a".repeat(40),
    checkout: async (_t, _p, commit) => ({ path: `/copies/${commit.slice(0, 1)}`, release: async () => {} }),
    limits: async () => ({ cpus: 2, memory: over.memory ?? "6g", minutes: undefined }),
    reportExisting: async (f) => {
      found.push({ kind: f.kind, problems: f.problems });
      return 7;
    },
    diff: async () => ({ files: [], commits: [] }),
    exec: async (_t, cwd, command) => {
      ran.push({ cwd, command });
      return over.run(cwd, command);
    },
    review: async () => ({ gaps: [], tokens: 0 }),
    autonomous: () => false,
    modelBlocked: () => undefined,
    tell: async () => {},
    hold: () => {},
    changed: () => {},
  };
  return { service: new HandoffService(ports, new HandoffRepo(db)), ran, found };
}

const lintSpec = (command: string): CheckSpec => ({
  command,
  env: { NODE_OPTIONS: "--max-old-space-size=6144" },
  from: "from .gitlab-ci.yml job lint",
});

describe("checks from CI, read-only", () => {
  it("runs a lint job that fixes without --fix, in the CI's environment and from the CI's file", async () => {
    const w = world({ specs: { lint: lintSpec("eslint --fix src") }, run: () => result(0), memory: "8g" });
    const out = await w.service.ensure("ACM-1", { force: false });
    expect(w.ran.map((r) => r.command)).toEqual(["eslint src"]);
    const lint = out.steps.find((s) => s.id === "lint");
    expect(lint?.ran).toEqual([
      {
        project: "acme-api",
        command: "eslint src",
        from: "from .gitlab-ci.yml job lint",
        env: { NODE_OPTIONS: "--max-old-space-size=6144" },
        notes: ["eslint ran read-only"],
      },
    ]);
  });

  it("does not block on a failure the base commit has, and blocks on a new one", async () => {
    const stylish = (rules: string[]) =>
      `src/a.ts\n${rules.map((r, i) => `  ${i + 1}:1  error  Bad  ${r}`).join("\n")}\n`;
    // The base has one lint error. The task's copy has that one and nothing else: not the task's.
    const same = world({
      specs: { lint: lintSpec("eslint src") },
      run: (cwd) => result(1, stylish(["no-var"])),
    });
    const a = await same.service.ensure("ACM-1", { force: false });
    expect(a.verdict).toBe("green");
    expect(a.steps.find((s) => s.id === "lint")).toMatchObject({
      status: "existing",
      existing: { base: "bbbbbbbb", problems: ["src/a.ts:no-var"], finding: 7 },
    });
    expect(same.found).toEqual([{ kind: "lint", problems: ["src/a.ts:no-var"] }]);

    // The task adds a second one: that one is new, so the check fails.
    const worse = world({
      specs: { lint: lintSpec("eslint src") },
      run: (cwd) => result(1, stylish(cwd.startsWith("/copies/b") ? ["no-var"] : ["no-var", "eqeqeq"])),
    });
    const b = await worse.service.ensure("ACM-1", { force: false });
    expect(b.verdict).toBe("red");
    expect(b.steps.find((s) => s.id === "lint")).toMatchObject({ status: "fail" });
    expect(worse.found).toEqual([]);
  });

  it("blocks when the base passes", async () => {
    const w = world({
      specs: { build: { command: "pnpm build", env: {}, from: "from the project card" } },
      run: (cwd) => (cwd.startsWith("/copies/b") ? result(0) : result(1, "build broke")),
    });
    const out = await w.service.ensure("ACM-1", { force: false });
    expect(out.steps.find((s) => s.id === "build")?.status).toBe("fail");
  });

  it("reports a memory kill with the limit, for the owner, and never as a plain failure", async () => {
    const w = world({
      specs: { build: { command: "pnpm build", env: {}, from: "from the project card" } },
      run: () => result(137, "Killed"),
      memory: "6g",
    });
    const out = await w.service.ensure("ACM-1", { force: false });
    const build = out.steps.find((s) => s.id === "build");
    expect(build).toMatchObject({ status: "fail", owner: true, memory: { limit: "6g" } });
    expect(build?.detail).toContain("Ran out of memory at 6 GB");
    expect(out.failures).toEqual([]);
    expect(out.held).toHaveLength(1);
  });
});

describe("a check never changes the task's files", () => {
  it("leaves the worktree clean, so a checkpoint has nothing of a check to commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "majhi-checkout-"));
    const source = join(root, "api");
    const folder = join(root, "task");
    const worktree = join(folder, "api");
    const who = ["-c", "user.name=Builder", "-c", "user.email=builder@example.com"];
    await git(root, ["init", "-q", "-b", "main", source]);
    await writeFile(join(source, "a.ts"), "export const a = 1;\n");
    await git(source, ["add", "."]);
    await git(source, [...who, "commit", "-qm", "init"]);
    await git(source, ["worktree", "add", "-q", "-b", "task/acm-1", worktree]);
    const head = (await git(worktree, ["rev-parse", "HEAD"])).trim();

    const copy = await makeCheckout({
      source,
      folder,
      project: "api",
      commit: head,
      installedFrom: worktree,
    });
    // What a lint --fix and a build do inside the copy.
    await writeFile(join(copy.path, "a.ts"), "export const a = 2;\n");
    await writeFile(join(copy.path, "generated.ts"), "// built\n");
    await copy.release();

    expect(await readFile(join(worktree, "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect((await git(worktree, ["status", "--porcelain"])).trim()).toBe("");
    const done = await commitCheckpoint(
      [{ project: "api", worktree, branch: "task/acm-1", base: "main" }],
      "ACM-1",
      1,
      commitBy({ name: "Owner", email: "owner@example.com" }, "ACM-1"),
    );
    expect(done.committed).toEqual([]);
  }, 30_000);
});
