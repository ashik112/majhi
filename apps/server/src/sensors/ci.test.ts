import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CiRun, ciHealth, judge, normalizeGithub, severityOf } from "./ci.ts";
import { ctxOf, FakeUpstream, findingsOf, GITHUB_PROJECT, live, makePorts, T0 } from "./testing.ts";

/** The CI sensor: cheap head checks, conditional requests, failing and flaky runs, closing when green. */

let up: FakeUpstream;
beforeEach(async () => {
  up = new FakeUpstream();
  await up.start();
});
afterEach(async () => {
  await up.stop();
});

const hoursAgo = (h: number) => new Date(T0.getTime() - h * 3_600_000).toISOString();

const ghRun = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  name: "CI",
  head_sha: "a".repeat(40),
  status: "completed",
  conclusion: "success",
  run_attempt: 1,
  created_at: hoursAgo(1),
  html_url: `https://github.com/acme/api/actions/runs/${id}`,
  ...over,
});

interface Repo {
  /** Newest first. */
  runs: ReturnType<typeof ghRun>[];
  sha: string;
}

/** A GitHub that answers the branch head and the runs, with ETags, and 304 for a matching If-None-Match. */
function github(repos: Record<string, Repo>) {
  up.handler = (req) => {
    const branch = /\/branches\/([^?/]+)/.exec(req.path);
    const runs = /branch=([^&]+)/.exec(req.path);
    const name = decodeURIComponent(branch?.[1] ?? runs?.[1] ?? "");
    const repo = repos[name];
    if (repo === undefined) return { status: 404 };
    if (branch !== null) {
      const etag = `"head-${repo.sha}"`;
      return req.headers["if-none-match"] === etag
        ? { status: 304 }
        : { headers: { etag }, body: { commit: { sha: repo.sha } } };
    }
    const etag = `"runs-${repo.sha}-${repo.runs.map((r) => `${r.id}${r.conclusion}${r.status}`).join("")}"`;
    return req.headers["if-none-match"] === etag
      ? { status: 304 }
      : { headers: { etag }, body: { workflow_runs: repo.runs } };
  };
}

function ci(opts: { repos?: Record<string, string[]>; token?: "signed-out" | "refused" } = {}) {
  const f = findingsOf();
  const { ports } = makePorts({
    net: up.net(),
    db: f.db,
    clock: f.clock,
    fixtures: [{ project: GITHUB_PROJECT, files: {} }],
    taskBranches: { "acme-api": opts.repos?.tasks ?? [] },
    ...(opts.token === undefined ? {} : { token: { state: opts.token } }),
  });
  const run = () => ciHealth(ports).run(ctxOf("eng-ci-health", f.findings, f.clock));
  const calls = () => up.seen.length;
  return { ...f, run, calls };
}

describe("judging runs", () => {
  const run = (id: string, state: CiRun["state"], over: Partial<CiRun> = {}): CiRun => ({
    id,
    workflow: "CI",
    sha: "s1",
    state,
    attempt: 1,
    at: hoursAgo(Number(id)),
    url: undefined,
    ...over,
  });

  it("a failing latest run fails, counting the streak from its first failure", () => {
    const { verdicts } = judge([run("1", "fail"), run("2", "fail"), run("3", "fail"), run("30", "ok")]);
    expect(verdicts[0]?.failing).toMatchObject({ streak: 3, since: hoursAgo(3) });
  });

  it("a pending run does not hide the last finished one, and is reported as pending", () => {
    const out = judge([run("1", "pending"), run("2", "fail")]);
    expect(out.pending).toBe(true);
    expect(out.verdicts[0]?.failing?.streak).toBe(1);
  });

  it("a pass after a failure on the same commit is flaky; a pass on a new commit is not", () => {
    expect(judge([run("1", "ok"), run("2", "fail")]).verdicts[0]?.flaky).toBeDefined();
    expect(judge([run("1", "ok", { sha: "s2" }), run("2", "fail")]).verdicts[0]?.flaky).toBeUndefined();
    expect(judge([run("1", "ok", { attempt: 2 })]).verdicts[0]?.flaky).toBeDefined();
  });

  it("cancelled and skipped runs say nothing", () => {
    expect(judge([run("1", "other"), run("2", "ok")]).verdicts[0]).toEqual({ workflow: "CI" });
  });

  it("severity follows how long and how often it failed", () => {
    expect(severityOf(true, { since: hoursAgo(1), streak: 1 }, T0)).toBe("medium");
    expect(severityOf(true, { since: hoursAgo(30), streak: 1 }, T0)).toBe("high");
    expect(severityOf(true, { since: hoursAgo(1), streak: 3 }, T0)).toBe("high");
    expect(severityOf(false, { since: hoursAgo(1), streak: 1 }, T0)).toBe("low");
    expect(severityOf(false, { since: hoursAgo(30), streak: 1 }, T0)).toBe("medium");
  });

  it("answers nothing for a body that is not a runs list", () => {
    expect(normalizeGithub({ workflow_runs: "x" })).toBeUndefined();
    expect(normalizeGithub(null)).toBeUndefined();
  });
});

describe("the CI sensor", () => {
  it("files a failing default branch with the run link, high when it has failed for a day, and closes it when green", async () => {
    const repo: Repo = {
      sha: "c1",
      runs: [
        ghRun(3, { conclusion: "failure", created_at: hoursAgo(2) }),
        ghRun(2, { conclusion: "failure", created_at: hoursAgo(26) }),
      ],
    };
    github({ main: repo });
    const t = ci();
    const res = await t.run();
    expect(res.findings).toBe(1);
    const [f] = live(t.findings);
    expect(f).toMatchObject({
      source: "ci",
      project: "acme-api",
      severity: "high",
      dedupeKey: "ci:acme-api:main:CI:failing",
      title: "CI fails on main",
    });
    expect(f?.evidence).toContain("https://github.com/acme/api/actions/runs/3");
    // The token goes in a header, and the request names only the repo and the branch.
    expect(up.seen[0]?.headers.authorization).toBe("Bearer test-token-value");
    expect(up.seen[0]?.path).toBe("/gh/repos/acme/api/branches/main");
    // Same head, still failing: it asks the runs again (a rerun does not move the head), and it is one finding.
    await t.run();
    expect(live(t.findings)).toHaveLength(1);
    // Fixed: a new head and a green run.
    repo.sha = "c2";
    repo.runs = [ghRun(4, { head_sha: "b".repeat(40) }), ...repo.runs];
    await t.run();
    expect(live(t.findings)[0]?.status).toBe("fixed");
  });

  it("an unchanged green branch costs one conditional request that answers 304, and then nothing", async () => {
    github({ main: { sha: "c1", runs: [ghRun(1)] } });
    const t = ci();
    await t.run();
    expect(t.calls()).toBe(2);
    // Within its wait: no request at all.
    await t.run();
    expect(t.calls()).toBe(2);
    // Past its wait: the head, with its ETag, answers 304 and the runs are not asked.
    t.clock.at = new Date(T0.getTime() + 3_600_000);
    await t.run();
    expect(t.calls()).toBe(3);
    expect(up.seen[2]?.headers["if-none-match"]).toBe('"head-c1"');
    expect(up.seen[2]?.path).toContain("/branches/main");
    // Each quiet poll doubles the wait, up to twelve hours.
    t.clock.at = new Date(T0.getTime() + 1.5 * 3_600_000);
    await t.run();
    expect(t.calls()).toBe(3);
    t.clock.at = new Date(T0.getTime() + 30 * 3_600_000);
    await t.run();
    expect(t.calls()).toBe(4);
    expect(live(t.findings)).toEqual([]);
  });

  it("a push brings the runs back, and a running pipeline is watched until it finishes", async () => {
    const repo: Repo = { sha: "c1", runs: [ghRun(1)] };
    github({ main: repo });
    const t = ci();
    await t.run();
    repo.sha = "c2";
    repo.runs = [
      ghRun(2, { status: "in_progress", conclusion: null, head_sha: "b".repeat(40) }),
      ...repo.runs,
    ];
    t.clock.at = new Date(T0.getTime() + 13 * 3_600_000);
    await t.run();
    const after = t.calls();
    // Pending: the next look is not held back by the wait.
    t.clock.at = new Date(T0.getTime() + 13 * 3_600_000 + 60_000);
    await t.run();
    expect(t.calls()).toBeGreaterThan(after);
  });

  it("files a flaky run as low and keeps one finding", async () => {
    github({
      main: {
        sha: "c1",
        runs: [ghRun(2, { run_attempt: 2 }), ghRun(1, { conclusion: "failure", created_at: hoursAgo(2) })],
      },
    });
    const t = ci();
    await t.run();
    await t.run();
    const found = live(t.findings);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ dedupeKey: "ci:acme-api:main:CI:flaky", severity: "low" });
  });

  it("reads open task branches as low, and dismisses the finding when the task is gone", async () => {
    github({
      main: { sha: "c1", runs: [ghRun(1)] },
      "majhi/acme-12": { sha: "t1", runs: [ghRun(5, { conclusion: "failure" })] },
    });
    const t = ci({ repos: { tasks: ["majhi/acme-12"] } });
    await t.run();
    expect(live(t.findings)[0]).toMatchObject({
      severity: "low",
      dedupeKey: "ci:acme-api:majhi/acme-12:CI:failing",
    });
    const gone = ci();
    // The same findings store, a new run with no open task: the finding is dismissed with the reason.
    const { ports } = makePorts({
      net: up.net(),
      db: t.db,
      clock: t.clock,
      fixtures: [{ project: GITHUB_PROJECT, files: {} }],
    });
    t.clock.at = new Date(T0.getTime() + 13 * 3_600_000);
    await ciHealth(ports).run(ctxOf("eng-ci-health", t.findings, t.clock));
    const f = t.findings.list({ org: "acme", limit: 10 }, { kind: "owner" }).findings[0];
    expect(f?.status).toBe("dismissed");
    expect(f?.dismissedReason).toMatch(/no longer an open task/);
    void gone;
  });

  it("reads GitLab pipelines through the project's own host and asks for no other", async () => {
    up.handler = (req) =>
      req.path.includes("/repository/branches/")
        ? { body: { commit: { id: "d1" } } }
        : {
            body: [
              {
                id: 9,
                sha: "d1",
                status: "failed",
                created_at: hoursAgo(3),
                web_url: "https://gitlab.acme.example/acme/api/-/pipelines/9",
              },
            ],
          };
    const f = findingsOf();
    const { ports } = makePorts({
      net: up.net(),
      db: f.db,
      clock: f.clock,
      fixtures: [
        {
          project: {
            ...GITHUB_PROJECT,
            remote: { kind: "gitlab", host: "gitlab.acme.example", slug: "acme/platform/api" },
          },
          files: {},
        },
      ],
    });
    await ciHealth(ports).run(ctxOf("eng-ci-health", f.findings, f.clock));
    expect(up.seen.map((s) => s.path)).toEqual([
      "/gl/api/v4/projects/acme%2Fplatform%2Fapi/repository/branches/main",
      "/gl/api/v4/projects/acme%2Fplatform%2Fapi/pipelines?ref=main&per_page=20",
    ]);
    expect(live(f.findings)[0]).toMatchObject({ source: "ci", title: "pipeline fails on main" });
  });

  it("makes no request without a sign-in, and says so", async () => {
    github({ main: { sha: "c1", runs: [ghRun(1)] } });
    const t = ci({ token: "signed-out" });
    const res = await t.run();
    expect(t.calls()).toBe(0);
    expect(res.note).toMatch(/not signed in to github\.com/);
  });

  it("a host that refuses the token fails the run so it backs off, and files nothing", async () => {
    up.handler = () => ({ status: 401 });
    const t = ci();
    await expect(t.run()).rejects.toThrow(/refused the token/);
    expect(live(t.findings)).toEqual([]);
  });

  it("a branch it cannot read keeps its findings", async () => {
    const repo: Repo = { sha: "c1", runs: [ghRun(1, { conclusion: "failure", created_at: hoursAgo(2) })] };
    github({ main: repo });
    const t = ci();
    await t.run();
    up.handler = () => ({ status: 503 });
    t.clock.at = new Date(T0.getTime() + 3_600_000);
    await expect(t.run()).rejects.toThrow();
    expect(live(t.findings)[0]?.status).toBe("open");
  });

  it("does nothing for a workspace with no GitHub or GitLab project", async () => {
    const f = findingsOf();
    const { ports } = makePorts({
      net: up.net(),
      db: f.db,
      clock: f.clock,
      fixtures: [{ project: { ...GITHUB_PROJECT, remote: undefined }, files: {} }],
    });
    expect(await ciHealth(ports).run(ctxOf("eng-ci-health", f.findings, f.clock))).toEqual({
      findings: 0,
      note: "No project on GitHub or GitLab",
    });
    expect(up.seen).toHaveLength(0);
  });
});
