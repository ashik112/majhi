import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createE2eRunner, parseReport } from "./e2e.ts";
import type { RunFn, RunOptions } from "./ssh.ts";

const COMMIT = "abcdef0123456789abcdef0123456789abcdef01";

const test = (status: string, attachments: unknown[] = []) => ({ status, results: [{ attachments }] });

/** The shape of Playwright's JSON reporter: a file suite, a describe, and specs. */
const report = (traceFile?: string) => ({
  suites: [
    {
      title: "phase1.spec.ts",
      specs: [{ title: "signs in", file: "phase1.spec.ts", tests: [test("expected")] }],
      suites: [
        {
          title: "Board",
          specs: [
            {
              title: "shows a card",
              file: "phase1.spec.ts",
              tests: [
                test(
                  "unexpected",
                  traceFile
                    ? [
                        { name: "trace", path: traceFile },
                        { name: "screenshot", path: "/x.png" },
                      ]
                    : [],
                ),
              ],
            },
            { title: "was flaky", file: "phase1.spec.ts", tests: [test("flaky")] },
            { title: "skipped", file: "phase1.spec.ts", tests: [test("skipped")] },
          ],
        },
      ],
    },
  ],
});

describe("parseReport", () => {
  it("counts a flaky test as passed and names a failure by file and titles", () => {
    const out = parseReport(report("/tmp/trace.zip"));
    expect(out.passed).toBe(2);
    expect(out.failed).toBe(1);
    expect(out.failedSpecs).toEqual(["phase1.spec.ts > Board > shows a card"]);
    expect(out.traces).toEqual([{ spec: "phase1.spec.ts > Board > shows a card", path: "/tmp/trace.zip" }]);
  });

  it("reads a report that is not one as empty", () => {
    expect(parseReport("nope")).toEqual({ passed: 0, failed: 0, failedSpecs: [], traces: [] });
    expect(parseReport({ suites: [{ specs: "x" }, 4] })).toEqual({
      passed: 0,
      failed: 0,
      failedSpecs: [],
      traces: [],
    });
  });
});

describe("e2e runner", () => {
  let home: string;
  let repo: string;
  let calls: Array<{ file: string; args: readonly string[]; options: RunOptions }>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "majhi-e2e-test-"));
    repo = join(home, "Work", "majhi");
    await mkdir(repo, { recursive: true });
    calls = [];
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  /** `suite` decides what the Playwright call does: write a report, and exit with a code. */
  function runner(suite: (options: RunOptions) => Promise<number | null>, opts: { noCommit?: boolean } = {}) {
    const run: RunFn = async (file, args, options) => {
      calls.push({ file, args, options });
      const git = args.indexOf("-c") === 0 ? args.slice(2) : args;
      if (file.endsWith("/git")) {
        if (git[0] === "cat-file") return { code: opts.noCommit ? 1 : 0, stdout: "", stderr: "" };
        if (git[0] === "worktree" && git[1] === "add") {
          await mkdir(join(git[4] ?? "", ".git"), { recursive: true });
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args.includes("playwright") && args.includes("test")) {
        return { code: await suite(options), stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    return createE2eRunner({
      run,
      majhiHome: join(home, ".majhi"),
      home,
      path: "/usr/bin",
      platform: "linux",
      find: async (name) => (name === "taskpolicy" ? undefined : `/usr/bin/${name}`),
      log: () => undefined,
      freePort: async () => 54321,
    });
  }

  const params = { runId: "run-1", repo: "", commit: COMMIT, timeoutMs: 3_600_000 };
  const start = (r: ReturnType<typeof runner>) => r({ ...params, repo });

  it("runs the suite in its own worktree at low priority, away from the owner's checkout and home", async () => {
    const result = await start(
      runner(async (options) => {
        await writeFile(
          options.env.PLAYWRIGHT_JSON_OUTPUT_NAME ?? "",
          JSON.stringify(report()).replace("unexpected", "expected"),
        );
        return 0;
      }),
    );
    expect(result).toMatchObject({ outcome: "passed", passed: 3, failed: 0, failedSpecs: [], traces: [] });

    const add = calls.find((c) => c.args.includes("worktree") && c.args.includes("add"));
    const worktree = join(home, ".majhi", "e2e", "worktree");
    expect(add?.args).toContain(worktree);
    expect(add?.args).toContain(COMMIT);
    // Never in the owner's checkout, and no git hooks of the owner's.
    expect(add?.options.cwd).toBe(repo);
    expect(add?.args.slice(0, 2)).toEqual(["-c", "core.hooksPath=/dev/null"]);

    const suite = calls.find((c) => c.args.includes("playwright") && c.args.includes("test"));
    expect(suite?.file).toBe("/usr/bin/nice");
    expect(suite?.args.slice(0, 3)).toEqual(["-n", "19", "/usr/bin/pnpm"]);
    expect(suite?.args).toContain("--reporter=json");
    expect(suite?.options.cwd).toBe(worktree);
    const env = suite?.options.env ?? {};
    expect(env.MAJHI_E2E_PORT).toBe("54321");
    expect(env.MAJHI_E2E_PORT).not.toBe("7070");
    // Nothing of majhi's own environment: no MAJHI_HOME, so ~/.majhi/majhi.db is out of reach.
    expect(Object.keys(env).filter((k) => k.startsWith("MAJHI_") && k !== "MAJHI_E2E_PORT")).toEqual([]);
    expect(env.TMPDIR?.startsWith(join(home, ".majhi", "e2e", "runs"))).toBe(true);
  });

  it("uses taskpolicy and nice on a Mac", async () => {
    const run: RunFn = async (file, args, options) => {
      calls.push({ file, args, options });
      if (file.endsWith("/git") && args.includes("worktree") && args.includes("add")) {
        await mkdir(join(args[args.indexOf("add") + 3] ?? "", ".git"), { recursive: true });
      }
      return { code: args.includes("test") ? 1 : 0, stdout: "", stderr: "" };
    };
    const mac = createE2eRunner({
      run,
      majhiHome: join(home, ".majhi"),
      home,
      path: "/usr/bin",
      platform: "darwin",
      find: async (name) => `/usr/bin/${name}`,
      log: () => undefined,
      freePort: async () => 54321,
    });
    await start(mac);
    const suite = calls.find((c) => c.args.includes("playwright") && c.args.includes("test"));
    expect(suite?.file).toBe("/usr/bin/taskpolicy");
    expect(suite?.args.slice(0, 5)).toEqual(["-b", "/usr/bin/nice", "-n", "19", "/usr/bin/pnpm"]);
  });

  it("reports the failing specs and keeps the traces outside the worktree", async () => {
    const trace = join(home, "trace.zip");
    await writeFile(trace, "zip");
    const result = await start(
      runner(async (options) => {
        await writeFile(options.env.PLAYWRIGHT_JSON_OUTPUT_NAME ?? "", JSON.stringify(report(trace)));
        return 1;
      }),
    );
    expect(result.outcome).toBe("failed");
    expect(result.failedSpecs).toEqual(["phase1.spec.ts > Board > shows a card"]);
    expect(result.traces).toHaveLength(1);
    const kept = result.traces[0]?.file ?? "";
    expect(kept.startsWith("e2e/traces/run-1/1-")).toBe(true);
    expect(await readFile(join(home, ".majhi", kept), "utf8")).toBe("zip");
    // The run's scratch folder is gone.
    await expect(stat(join(home, ".majhi", "e2e", "runs", "run-1"))).rejects.toThrow();
  });

  it("is errored, not failed, when the suite leaves no report or times out", async () => {
    expect(await start(runner(async () => 1))).toMatchObject({
      outcome: "errored",
      error: "The suite ended without a report.",
    });
    expect(await start(runner(async () => null))).toMatchObject({
      outcome: "errored",
      error: "The suite did not finish in time, so it was stopped.",
    });
  });

  it("refuses a commit the repository does not have, and a relative repo path", async () => {
    expect(await start(runner(async () => 0, { noCommit: true }))).toMatchObject({ outcome: "errored" });
    await expect(runner(async () => 0)({ ...params, repo: "relative/path" })).rejects.toThrow("absolute");
  });

  it("runs one suite at a time", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = runner(async () => {
      await gate;
      return 1;
    });
    const first = start(r);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(start(r)).rejects.toThrow("already in progress");
    release();
    await first;
  });
});
