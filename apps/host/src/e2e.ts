import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { E2E_MAX_SPECS, E2E_MAX_TRACES, type E2eRunResult } from "@majhi/shared";
import { filtersOff, GUARD_CONFIG, GUARD_ENV, LIST_FILTERS, withConfig } from "./gitGuard.ts";
import type { Logger } from "./log.ts";
import type { RunFn } from "./ssh.ts";

/** Folder under the majhi folder: `worktree` (the helper's own checkout), `runs`, `traces`. */
export const E2E_DIR = "e2e";
/** The traces of this many runs are kept; older folders are removed when a run ends. */
const KEEP_TRACE_RUNS = 20;
/** A trace bigger than this is left out: a task takes attachments up to 20 MB. */
const MAX_TRACE_BYTES = 19 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 20 * 60_000;
const BROWSER_TIMEOUT_MS = 10 * 60_000;

export interface E2eDeps {
  run: RunFn;
  majhiHome: string;
  /** The owner's home: pnpm's store and Playwright's browsers live under it. */
  home: string;
  /** The helper's PATH, already extended with the usual tool folders. */
  path: string;
  platform: string;
  find: (name: string, path: string) => Promise<string | undefined>;
  log: Logger;
  freePort?: () => Promise<number>;
  now?: () => number;
}

/** What the report of Playwright's JSON reporter says, reduced to what majhi shows. */
export interface ReportSummary {
  passed: number;
  failed: number;
  failedSpecs: string[];
  /** Absolute trace files of failing tests, with the spec they belong to. */
  traces: Array<{ spec: string; path: string }>;
}

interface JsonSpec {
  title?: unknown;
  file?: unknown;
  tests?: unknown;
}
interface JsonSuite {
  title?: unknown;
  suites?: unknown;
  specs?: unknown;
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const asText = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Reads Playwright's JSON report. A test counts as failed when its final status is `unexpected`
 * (so a flaky test, which passed on a retry, is a pass). The spec is named `file > titles`.
 */
export function parseReport(report: unknown): ReportSummary {
  const summary: ReportSummary = { passed: 0, failed: 0, failedSpecs: [], traces: [] };
  const walk = (suite: JsonSuite, titles: string[]): void => {
    const here = asText(suite.title);
    const next = here === "" ? titles : [...titles, here];
    for (const raw of asArray(suite.specs)) {
      const spec = raw as JsonSpec;
      for (const rawTest of asArray(spec.tests)) {
        const test = asRecord(rawTest);
        const status = asText(test.status);
        if (status === "expected" || status === "flaky") summary.passed += 1;
        if (status !== "unexpected") continue;
        summary.failed += 1;
        const file = asText(spec.file);
        const name = [...(next[0] === file ? next.slice(1) : next), asText(spec.title)].join(" > ");
        const label = file === "" ? name : `${file} > ${name}`;
        summary.failedSpecs.push(label);
        const results = asArray(test.results).map(asRecord);
        const last = results[results.length - 1];
        for (const attachment of asArray(last?.attachments).map(asRecord)) {
          const path = asText(attachment.path);
          if (asText(attachment.name) === "trace" && path !== "") summary.traces.push({ spec: label, path });
        }
      }
    }
    for (const child of asArray(suite.suites)) walk(child as JsonSuite, next);
  };
  const root = asRecord(report);
  for (const top of asArray(root.suites)) walk(top as JsonSuite, []);
  return summary;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** `slug-of-a-spec`, for a file name. */
function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "spec"
  );
}

export type E2eRunner = (params: {
  runId: string;
  repo: string;
  commit: string;
  timeoutMs: number;
}) => Promise<E2eRunResult>;

/**
 * Runs the project's Playwright suite at one commit, away from the owner's work:
 * - in the helper's own worktree of the project (`<majhi folder>/e2e/worktree`), detached at the commit,
 *   never in the owner's checkout;
 * - at low priority (`nice`, and `taskpolicy -b` on a Mac);
 * - with an environment built from scratch: PATH, HOME, a TMPDIR of its own (where the suite's
 *   per-worker temp homes go) and MAJHI_E2E_PORT, a free port that is never 7070. No MAJHI_HOME, so
 *   the owner's ~/.majhi/majhi.db is out of reach.
 * One run at a time. Messages are fixed sentences: the tools' own output is not passed on.
 */
export function createE2eRunner(deps: E2eDeps): E2eRunner {
  const root = join(deps.majhiHome, E2E_DIR);
  const now = deps.now ?? Date.now;
  let busy = false;

  return async ({ runId, repo, commit, timeoutMs }) => {
    if (busy) throw new Error("An e2e run is already in progress on this computer.");
    if (!isAbsolute(repo) || repo.includes("\0")) throw new Error("The repo path must be absolute.");
    busy = true;
    const started = now();
    const runDir = join(root, "runs", runId);
    const errored = (error: string): E2eRunResult => ({
      outcome: "errored",
      durationMs: Math.max(0, now() - started),
      passed: 0,
      failed: 0,
      failedSpecs: [],
      traces: [],
      error,
    });
    try {
      const git = await deps.find("git", deps.path);
      const pnpm = await deps.find("pnpm", deps.path);
      if (git === undefined) return errored("git is not on this computer's PATH.");
      if (pnpm === undefined) return errored("pnpm is not on this computer's PATH.");
      const env: Record<string, string> = {
        PATH: deps.path,
        HOME: deps.home,
        CI: "1",
        // Every worker's throwaway home and port are made by the suite itself (e2e/fixture.ts).
        // MAJHI_E2E_PORT is for a server the suite starts on its own: never the owner's 7070.
        MAJHI_E2E_PORT: String(await (deps.freePort ?? freePort)()),
        TMPDIR: join(runDir, "tmp"),
        PLAYWRIGHT_JSON_OUTPUT_NAME: join(runDir, "report.json"),
      };
      await rm(runDir, { recursive: true, force: true });
      await mkdir(env.TMPDIR as string, { recursive: true });

      const worktree = join(root, "worktree");
      // The helper's guards (gitGuard.ts), and no filter driver of the repo's or the worktree's own
      // config on checkout: an agent outside a container can edit both.
      const gitRun = async (cwd: string, args: string[]) => {
        const opts = {
          env: { PATH: deps.path, HOME: deps.home, GIT_TERMINAL_PROMPT: "0", ...GUARD_ENV },
          timeoutMs: GIT_TIMEOUT_MS,
          cwd,
        };
        const listed = await deps.run(git, [...GUARD_CONFIG, ...LIST_FILTERS], opts);
        const off = filtersOff(listed.code === 0 ? listed.stdout : "");
        return deps.run(git, [...GUARD_CONFIG, ...args], { ...opts, env: withConfig(opts.env, off) });
      };
      const has = await gitRun(repo, ["cat-file", "-e", `${commit}^{commit}`]);
      if (has.code !== 0) return errored("The commit is not in the project's repository on this computer.");
      await mkdir(root, { recursive: true });
      await gitRun(repo, ["worktree", "prune"]);
      const existing = await stat(join(worktree, ".git")).then(
        () => true,
        () => false,
      );
      if (existing) {
        const moved = await gitRun(worktree, ["checkout", "--detach", "--force", commit]);
        if (moved.code === 0) {
          // Keep node_modules (pnpm reuses it); drop everything else a past run left, like the web build.
          await gitRun(worktree, ["clean", "-fdxq", "-e", "node_modules"]);
        } else {
          await gitRun(repo, ["worktree", "remove", "--force", worktree]);
          await rm(worktree, { recursive: true, force: true });
        }
      }
      if (
        !(await stat(join(worktree, ".git")).then(
          () => true,
          () => false,
        ))
      ) {
        const added = await gitRun(repo, ["worktree", "add", "--detach", "--force", worktree, commit]);
        if (added.code !== 0)
          return errored("The helper could not check the commit out in its own worktree.");
      }

      const prefix = lowPriority(
        deps.platform,
        await deps.find("taskpolicy", deps.path),
        await deps.find("nice", deps.path),
      );
      const step = (cwd: string, file: string, args: string[], timeout: number) => {
        const [program = file, ...rest] = [...prefix, file, ...args];
        return deps.run(program, rest, { env, timeoutMs: timeout, cwd });
      };
      const install = await step(
        worktree,
        pnpm,
        ["install", "--frozen-lockfile", "--prefer-offline"],
        INSTALL_TIMEOUT_MS,
      );
      if (install.code !== 0) return errored("pnpm install failed in the e2e worktree.");
      // A no-op when the browser is there. A failure here shows as the suite's own failure.
      await step(worktree, pnpm, ["exec", "playwright", "install", "chromium"], BROWSER_TIMEOUT_MS);

      deps.log(`e2e ${runId}: running the suite at ${commit.slice(0, 7)}`);
      const suite = await step(
        worktree,
        pnpm,
        ["exec", "playwright", "test", "--reporter=json", `--output=${join(runDir, "results")}`],
        Math.max(60_000, timeoutMs - (now() - started)),
      );
      const durationMs = Math.max(0, now() - started);
      if (suite.code === null) return errored("The suite did not finish in time, so it was stopped.");

      let report: unknown;
      try {
        report = JSON.parse(await readFile(join(runDir, "report.json"), "utf8"));
      } catch {
        return errored("The suite ended without a report.");
      }
      const summary = parseReport(report);
      if (suite.code === 0 && summary.failed === 0) {
        return {
          outcome: "passed",
          durationMs,
          passed: summary.passed,
          failed: 0,
          failedSpecs: [],
          traces: [],
        };
      }
      if (summary.failed === 0) return errored("The suite stopped before running its tests.");
      return {
        outcome: "failed",
        durationMs,
        passed: summary.passed,
        failed: summary.failed,
        failedSpecs: summary.failedSpecs.slice(0, E2E_MAX_SPECS),
        traces: await keepTraces(root, runId, summary.traces),
      };
    } catch (err) {
      deps.log(`e2e ${runId}: ${err instanceof Error ? err.message : String(err)}`);
      return errored("The helper could not run the suite.");
    } finally {
      busy = false;
      await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
      await pruneTraces(root).catch(() => undefined);
    }
  };
}

/** What goes before the program: `taskpolicy -b nice -n 19` on a Mac, `nice -n 19` elsewhere, or nothing. */
function lowPriority(platform: string, taskpolicy: string | undefined, nice: string | undefined): string[] {
  if (nice === undefined) return [];
  if (platform === "darwin" && taskpolicy !== undefined) return [taskpolicy, "-b", nice, "-n", "19"];
  return [nice, "-n", "19"];
}

/** Copies up to E2E_MAX_TRACES traces to `traces/<run>/`, outside the worktree that the next run wipes. */
async function keepTraces(
  root: string,
  runId: string,
  traces: ReportSummary["traces"],
): Promise<E2eRunResult["traces"]> {
  const kept: E2eRunResult["traces"] = [];
  const dir = join(root, "traces", runId);
  for (const trace of traces) {
    if (kept.length >= E2E_MAX_TRACES) break;
    const size = await stat(trace.path).then(
      (s) => (s.isFile() ? s.size : -1),
      () => -1,
    );
    if (size < 0 || size > MAX_TRACE_BYTES) continue;
    await mkdir(dir, { recursive: true });
    const name = `${kept.length + 1}-${slug(trace.spec)}.zip`;
    await copyFile(trace.path, join(dir, name));
    kept.push({ spec: trace.spec.slice(0, 300), file: `${E2E_DIR}/traces/${runId}/${name}` });
  }
  return kept;
}

/** Removes the oldest trace folders past KEEP_TRACE_RUNS. */
async function pruneTraces(root: string): Promise<void> {
  const base = join(root, "traces");
  const entries = await readdir(base).catch(() => [] as string[]);
  const dated = await Promise.all(
    entries.map(async (name) => ({ name, at: (await stat(join(base, name))).mtimeMs })),
  );
  dated.sort((a, b) => b.at - a.at);
  for (const old of dated.slice(KEEP_TRACE_RUNS)) {
    await rm(join(base, old.name), { recursive: true, force: true });
  }
}
