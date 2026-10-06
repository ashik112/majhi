import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../store/migrations.ts";
import {
  capLog,
  isCheckLog,
  LOG_CAP_CHARS,
  logPath,
  newRunId,
  OutputKeeper,
  pruneRuns,
  StepLog,
  writeStepLog,
} from "./logs.ts";
import { HandoffRepo } from "./repo.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "majhi-logs-"));
  dirs.push(d);
  return d;
}

describe("where a step's log goes", () => {
  it("is one plain path under the task folder, and a run or step that is anything else is refused", () => {
    const run = newRunId();
    expect(logPath(run, "tests")).toBe(`.checks/${run}/tests.log`);
    for (const bad of ["..", "../x", "a/b", "", ".hidden", "A", "-x", "x".repeat(41), "a\0b"]) {
      expect(() => logPath(bad, "tests")).toThrow();
    }
    expect(() => logPath(run, "../../etc/passwd")).toThrow();
    expect(() => logPath(run, "other")).toThrow();
  });

  it("the files route serves only .checks/<run>/<step>.log, nothing deeper or beside it", () => {
    expect(isCheckLog([".checks", "mux3yqk1-a02329", "tests.log"])).toBe(true);
    expect(isCheckLog([".checks", "mux3yqk1-a02329", "home"])).toBe(false);
    expect(isCheckLog([".checks", "mux3yqk1-a02329", "notes.log"])).toBe(false);
    expect(isCheckLog([".checks", "..", "tests.log"])).toBe(false);
    expect(isCheckLog([".checks", "a", "b", "tests.log"])).toBe(false);
    expect(isCheckLog([".env", "a", "tests.log"])).toBe(false);
  });

  it("is written inside the task folder, and never through a link an agent put there", async () => {
    const folder = await temp();
    const outside = await temp();
    const written = await writeStepLog(folder, "run1", "lint", "all clear\n");
    expect(written).toBe(".checks/run1/lint.log");
    expect(await readFile(join(folder, written), "utf8")).toBe("all clear\n");

    // The agent replaces .checks with a link to a folder elsewhere.
    const other = await temp();
    await symlink(outside, join(other, ".checks"));
    await expect(writeStepLog(other, "run1", "lint", "x")).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);

    // Or a run folder, or the file itself.
    const third = await temp();
    await mkdir(join(third, ".checks"));
    await symlink(outside, join(third, ".checks", "run2"));
    await expect(writeStepLog(third, "run2", "lint", "x")).rejects.toThrow();
    const fourth = await temp();
    await mkdir(join(fourth, ".checks", "run3"), { recursive: true });
    await writeFile(join(outside, "target"), "keep");
    await symlink(join(outside, "target"), join(fourth, ".checks", "run3", "lint.log"));
    await expect(writeStepLog(fourth, "run3", "lint", "x")).rejects.toThrow();
    expect(await readFile(join(outside, "target"), "utf8")).toBe("keep");
    expect(await readdir(outside).then((n) => n.sort())).toEqual(["target"]);
  });

  it("keeps the newest runs and removes the older ones", async () => {
    const folder = await temp();
    for (const run of ["a1", "a2", "a3", "a4", "a5", "a6", "a7"])
      await writeStepLog(folder, run, "tests", run);
    await pruneRuns(folder, 5);
    expect(await readdir(join(folder, ".checks"))).toEqual(["a3", "a4", "a5", "a6", "a7"]);
  });
});

describe("a long output", () => {
  it("is kept whole under the cap", () => {
    const keeper = new OutputKeeper();
    keeper.push("one\ntwo\n");
    keeper.push("three\n");
    expect(keeper.result()).toEqual({ text: "one\ntwo\nthree\n", cut: 0 });
  });

  it("keeps its start and its end past the cap, in bounded memory, and says where it was cut", () => {
    const keeper = new OutputKeeper();
    const line = `${"x".repeat(98)}\n`;
    const lines = 30_000;
    for (let i = 0; i < lines; i++)
      keeper.push(i === 0 ? `FIRST ${line}` : i === lines - 1 ? `LAST ${line}` : line);
    const { text, cut } = keeper.result();
    expect(cut).toBeGreaterThan(1_000_000);
    expect(text.startsWith("FIRST ")).toBe(true);
    expect(text.trimEnd().endsWith(`LAST ${"x".repeat(98)}`)).toBe(true);
    expect(text).toContain("[majhi: output cut at 0.95 MB,");
    expect(text.length).toBeLessThan(LOG_CAP_CHARS + 200);
  });

  it("opens at the first line of the tail the card shows, also after a cut", () => {
    const body = Array.from({ length: 60 }, (_, i) => `row ${i + 1}`).join("\n");
    const tail = body.split("\n").slice(-25).join("\n");
    const log = new StepLog();
    log.add("==> cmd: exit 1 after 2 s", body, tail);
    const saved = log.finish(".checks/r/tests.log");
    expect(saved.text.split("\n")[saved.log.focus - 1]).toBe("row 36");
    expect(saved.log).toMatchObject({ lines: 61, bytes: Buffer.byteLength(saved.text) });

    const big = new StepLog();
    const huge = Array.from({ length: 40_000 }, (_, i) => `row ${i + 1} ${"y".repeat(40)}`).join("\n");
    big.add("==> cmd: exit 1 after 2 s", huge, huge.split("\n").slice(-25).join("\n"));
    const cut = big.finish(".checks/r/tests.log");
    expect(cut.log.cut).toBeGreaterThan(0);
    expect(cut.text.split("\n")[cut.log.focus - 1]).toBe(`row 39976 ${"y".repeat(40)}`);
    expect(capLog("short").cut).toBe(0);
  });
});

describe("a check saved before logs were kept", () => {
  it("still reads: no failed step, no log, no exit code", () => {
    const db = new Database(":memory:");
    migrate(db);
    const old = {
      task: "ACM-1",
      head: "acme-api@aaa111",
      at: "2026-09-01T10:00:00.000Z",
      verdict: "red",
      steps: [
        { id: "ready", label: "Merge checks", status: "pass", detail: "committed" },
        {
          id: "tests",
          label: "Tests",
          status: "fail",
          detail: "`pnpm test` failed (exit 1, 3 s)",
          ms: 3000,
          output: "boom",
        },
      ],
      review: { by: "skipped", why: "the tests, build or lint did not pass", notes: [], tokens: 0 },
      failures: ["`pnpm test` failed (exit 1, 3 s)\nboom"],
      held: [],
      ms: 4000,
      cached: false,
      summary: "Checked: tests failed (3 s)",
    };
    db.prepare(
      "INSERT INTO handoff_history (task, head, at, verdict, failures, action, result) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("ACM-1", old.head, old.at, "red", JSON.stringify(old.failures), "told", JSON.stringify(old));
    db.prepare(
      "INSERT INTO handoff_deep (task, head, at, ms, steps, review, env, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("ACM-1", old.head, old.at, 3000, JSON.stringify(old.steps), JSON.stringify(old.review), "", 1);
    const repo = new HandoffRepo(db);
    const result = repo.resultOf("ACM-1", old.head);
    expect(result?.verdict).toBe("red");
    expect(result?.failed).toBeUndefined();
    expect(result?.steps[1]?.log).toBeUndefined();
    expect(repo.deep("ACM-1", old.head)?.steps).toHaveLength(2);
    expect(repo.lastResult("ACM-1")?.failures).toEqual(old.failures);
  });
});
