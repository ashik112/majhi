import { z } from "zod";
import { errorMessage } from "../errors.ts";
import type { RulesContext, RulesResult } from "../playbooks/rules.ts";
import { Unavailable } from "./net.ts";
import { file, type Reporter, type SensorPorts, type SensorProject } from "./ports.ts";

/**
 * The CI sensor (SPEC 5.18, sensors). For each project with a GitHub or GitLab remote it reads the
 * latest pipeline runs of the default branch and of the branches of open tasks, through the
 * workspace's own git sign-in. It asks cheaply: the branch head first, with the ETag from last time,
 * so an unchanged green branch costs one request that answers 304 (free of GitHub's rate limit) and
 * nothing more. A branch that stays unchanged is looked at less often (its wait doubles up to twelve
 * hours); a push or a running pipeline brings it back to the normal pace. Failing and flaky runs become
 * findings with a dedupe key per project, branch and workflow; a green run closes them.
 */

export const GITHUB_API = "https://api.github.com";
const MAX_TASK_BRANCHES = 5;
const BASE_WAIT_MS = 30 * 60_000;
const MAX_WAIT_MS = 12 * 3_600_000;
const HOUR = 3_600_000;

export type RunState = "ok" | "fail" | "pending" | "other";

export interface CiRun {
  id: string;
  workflow: string;
  sha: string;
  state: RunState;
  attempt: number;
  at: string;
  url: string | undefined;
}

const GhRuns = z.object({
  workflow_runs: z
    .array(
      z.object({
        id: z.number(),
        name: z.string().nullable().optional(),
        head_sha: z.string(),
        status: z.string().nullable().optional(),
        conclusion: z.string().nullable().optional(),
        run_attempt: z.number().optional(),
        created_at: z.string(),
        html_url: z.string().optional(),
      }),
    )
    .max(100),
});
const GhBranch = z.object({ commit: z.object({ sha: z.string() }) });
const GlPipelines = z
  .array(
    z.object({
      id: z.number(),
      sha: z.string(),
      status: z.string(),
      created_at: z.string(),
      web_url: z.string().optional(),
    }),
  )
  .max(100);
const GlBranch = z.object({ commit: z.object({ id: z.string() }) });

function ghState(status: string | null | undefined, conclusion: string | null | undefined): RunState {
  if (status !== "completed") return "pending";
  switch (conclusion) {
    case "success":
      return "ok";
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "fail";
    default:
      return "other";
  }
}

function glState(status: string): RunState {
  switch (status) {
    case "success":
      return "ok";
    case "failed":
      return "fail";
    case "canceled":
    case "skipped":
    case "manual":
      return "other";
    default:
      return "pending";
  }
}

export function normalizeGithub(body: unknown): CiRun[] | undefined {
  const parsed = GhRuns.safeParse(body);
  if (!parsed.success) return undefined;
  return parsed.data.workflow_runs.map((r) => ({
    id: String(r.id),
    workflow: (r.name ?? "workflow").slice(0, 80),
    sha: r.head_sha,
    state: ghState(r.status, r.conclusion),
    attempt: r.run_attempt ?? 1,
    at: r.created_at,
    url: r.html_url,
  }));
}

export function normalizeGitlab(body: unknown): CiRun[] | undefined {
  const parsed = GlPipelines.safeParse(body);
  if (!parsed.success) return undefined;
  return parsed.data.map((r) => ({
    id: String(r.id),
    workflow: "pipeline",
    sha: r.sha,
    state: glState(r.status),
    attempt: 1,
    at: r.created_at,
    url: r.web_url,
  }));
}

export interface Verdict {
  workflow: string;
  failing?: { since: string; streak: number; url: string | undefined; sha: string };
  flaky?: { sha: string; url: string | undefined };
}

/**
 * What the newest runs say, per workflow. Runs come newest first. Failing: the latest finished run
 * failed; `since` is the first failure of the streak. Flaky: the latest finished run passed on a commit
 * where a run of the same workflow failed before (a rerun, or a second attempt).
 */
export function judge(runs: readonly CiRun[]): { verdicts: Verdict[]; pending: boolean } {
  const by = new Map<string, CiRun[]>();
  for (const r of runs) by.set(r.workflow, [...(by.get(r.workflow) ?? []), r]);
  const verdicts: Verdict[] = [];
  let pending = false;
  for (const [workflow, list] of by) {
    if (list[0]?.state === "pending") pending = true;
    const done = list.filter((r) => r.state === "ok" || r.state === "fail");
    const cur = done[0];
    if (cur === undefined) continue;
    if (cur.state === "fail") {
      let streak = 0;
      let since = cur.at;
      for (const r of done) {
        if (r.state !== "fail") break;
        streak += 1;
        since = r.at;
      }
      verdicts.push({ workflow, failing: { since, streak, url: cur.url, sha: cur.sha } });
    } else {
      const failedBefore = done.some(
        (r) => r.sha === cur.sha && r.state === "fail" && Date.parse(r.at) <= Date.parse(cur.at),
      );
      verdicts.push({
        workflow,
        ...(failedBefore || cur.attempt > 1 ? { flaky: { sha: cur.sha, url: cur.url } } : {}),
      });
    }
  }
  return { verdicts, pending };
}

export function severityOf(
  isDefault: boolean,
  failing: { since: string; streak: number },
  now: Date,
): "low" | "medium" | "high" {
  const hours = (now.getTime() - Date.parse(failing.since)) / HOUR;
  if (isDefault) return hours >= 24 || failing.streak >= 3 ? "high" : "medium";
  return hours >= 24 || failing.streak >= 3 ? "medium" : "low";
}

const StateSchema = z.object({
  sha: z.string().optional(),
  headEtag: z.string().optional(),
  runsEtag: z.string().optional(),
  pending: z.boolean().default(false),
  failing: z.boolean().default(false),
  wait: z.number().default(BASE_WAIT_MS),
  runs: z.array(z.unknown()).default([]),
});
type State = z.infer<typeof StateSchema>;

interface Target {
  /** Request URL for the branch head, and for the runs. */
  head: string;
  runs: string;
  headers: Record<string, string>;
  shaOf: (body: unknown) => string | undefined;
  normalize: (body: unknown) => CiRun[] | undefined;
}

function targetFor(project: SensorProject, branch: string, token: string): Target | undefined {
  const remote = project.remote;
  if (remote === undefined) return undefined;
  const headers = { authorization: `Bearer ${token}` };
  const b = encodeURIComponent(branch);
  if (remote.kind === "github") {
    const repo = remote.slug.split("/").map(encodeURIComponent).join("/");
    return {
      head: `${GITHUB_API}/repos/${repo}/branches/${b}`,
      runs: `${GITHUB_API}/repos/${repo}/actions/runs?branch=${b}&per_page=20`,
      headers: { ...headers, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      shaOf: (body) => {
        const p = GhBranch.safeParse(body);
        return p.success ? p.data.commit.sha : undefined;
      },
      normalize: normalizeGithub,
    };
  }
  const id = encodeURIComponent(remote.slug);
  const base = `https://${remote.host}/api/v4/projects/${id}`;
  return {
    head: `${base}/repository/branches/${b}`,
    runs: `${base}/pipelines?ref=${b}&per_page=20`,
    headers,
    shaOf: (body) => {
      const p = GlBranch.safeParse(body);
      return p.success ? p.data.commit.id : undefined;
    },
    normalize: normalizeGitlab,
  };
}

/** One branch: the cheap head check first, then the runs only when something may have changed. */
async function pollBranch(
  ports: SensorPorts,
  project: SensorProject,
  branch: string,
  token: string,
): Promise<{ runs: CiRun[]; asked: boolean } | undefined> {
  const t = targetFor(project, branch, token);
  if (t === undefined) return undefined;
  const key = `ci:${project.id}:${branch}`;
  const row = ports.cache.json(key, (raw) => {
    const r = StateSchema.safeParse(raw);
    return r.success ? r.data : undefined;
  });
  const old: State | undefined = row?.value;
  const now = ports.now();
  const asRuns = (state: State | undefined): CiRun[] => (state?.runs ?? []) as CiRun[];
  // A quiet branch waits; a running pipeline or a failure is watched at the normal pace.
  if (
    old !== undefined &&
    !old.pending &&
    !old.failing &&
    row?.row.nextAt !== undefined &&
    Date.parse(row.row.nextAt) > now.getTime()
  ) {
    return { runs: asRuns(old), asked: false };
  }
  const head = await ports.net.json(t.head, {
    headers: t.headers,
    ...(old?.headEtag === undefined ? {} : { etag: old.headEtag }),
  });
  if (head.status === 404) return { runs: [], asked: true };
  if (head.status === 401 || head.status === 403) throw new Unavailable("the git host refused the token");
  const sha = head.status === 304 ? old?.sha : t.shaOf(head.body);
  const unchanged = head.status === 304 || (old?.sha !== undefined && sha === old.sha);
  if (unchanged && old !== undefined && !old.pending && !old.failing) {
    const wait = Math.min(old.wait * 2, MAX_WAIT_MS);
    save(ports, key, { ...old, sha, headEtag: head.etag ?? old.headEtag, wait }, wait);
    return { runs: asRuns(old), asked: true };
  }
  const runs = await ports.net.json(t.runs, {
    headers: t.headers,
    ...(old?.runsEtag === undefined || !unchanged ? {} : { etag: old.runsEtag }),
  });
  if (runs.status === 304 && old !== undefined) {
    save(ports, key, { ...old, sha, headEtag: head.etag ?? old.headEtag }, BASE_WAIT_MS);
    return { runs: asRuns(old), asked: true };
  }
  const list = runs.status === 200 ? t.normalize(runs.body) : undefined;
  if (list === undefined) throw new Unavailable(`the git host answered ${runs.status} for the pipeline runs`);
  const verdict = judge(list);
  save(
    ports,
    key,
    {
      sha,
      headEtag: head.etag,
      runsEtag: runs.etag,
      pending: verdict.pending,
      failing: verdict.verdicts.some((v) => v.failing !== undefined),
      wait: BASE_WAIT_MS,
      runs: list.slice(0, 20),
    },
    BASE_WAIT_MS,
  );
  return { runs: list, asked: true };
}

function save(ports: SensorPorts, key: string, state: State, waitMs: number): void {
  const at = ports.now();
  ports.cache.put({
    key,
    ...(state.headEtag === undefined ? {} : { etag: state.headEtag }),
    body: JSON.stringify(state),
    at: at.toISOString(),
    nextAt: new Date(at.getTime() + waitMs).toISOString(),
  });
}

async function report(
  r: Reporter,
  ports: SensorPorts,
  project: SensorProject,
  branch: string,
  isDefault: boolean,
  runs: readonly CiRun[],
  seen: Set<string>,
): Promise<number> {
  let news = 0;
  const label = isDefault ? `${branch} (the default branch)` : `${branch} (a task branch)`;
  for (const v of judge(runs).verdicts) {
    if (v.failing !== undefined) {
      const key = `ci:${project.id}:${branch}:${v.workflow}:failing`;
      seen.add(key);
      const hours = Math.max(0, Math.round((ports.now().getTime() - Date.parse(v.failing.since)) / HOUR));
      await file(r, {
        project: project.id,
        source: "ci",
        key,
        title: `${v.workflow} fails on ${branch}`,
        detail: `${v.workflow} has failed ${v.failing.streak} ${v.failing.streak === 1 ? "run" : "runs"} in a row on ${label}, for about ${hours} ${hours === 1 ? "hour" : "hours"}.`,
        evidence: [
          `commit ${v.failing.sha.slice(0, 10)}`,
          ...(v.failing.url === undefined ? [] : [v.failing.url]),
        ],
        severity: severityOf(isDefault, v.failing, ports.now()),
      });
      news += 1;
    }
    if (v.flaky !== undefined) {
      const key = `ci:${project.id}:${branch}:${v.workflow}:flaky`;
      seen.add(key);
      await file(r, {
        project: project.id,
        source: "ci",
        key,
        title: `${v.workflow} is flaky on ${branch}`,
        detail: `${v.workflow} failed and then passed on the same commit (${v.flaky.sha.slice(0, 10)}) on ${label}. A test or a step is unreliable.`,
        evidence: [`commit ${v.flaky.sha.slice(0, 10)}`, ...(v.flaky.url === undefined ? [] : [v.flaky.url])],
        severity: "low",
      });
      news += 1;
    }
  }
  return news;
}

export function ciHealth(ports: SensorPorts) {
  return {
    async run(ctx: RulesContext): Promise<RulesResult> {
      const r: Reporter = { findings: ctx.findings, org: ctx.org, playbook: ctx.playbook.id };
      const projects = (await ports.projects(ctx.org)).filter(
        (p) => p.remote !== undefined && p.base !== undefined,
      );
      if (projects.length === 0) return { findings: 0, note: "No project on GitHub or GitLab" };
      let filed = 0;
      let looked = 0;
      const notes: string[] = [];
      for (const project of projects) {
        const remote = project.remote;
        if (remote === undefined || project.base === undefined) continue;
        ports.net.allowHost(remote.kind === "github" ? "api.github.com" : remote.host);
        const tasks = (await ports.taskBranches(ctx.org, project.id))
          .filter((b) => b !== project.base)
          .slice(0, MAX_TASK_BRANCHES);
        const branches = [project.base, ...new Set(tasks)];
        const used = await ports.withToken(ctx.org, remote.kind, remote.host, async (token) => {
          const seen = new Set<string>();
          const kept: string[] = [];
          let news = 0;
          let failed = 0;
          for (const branch of branches) {
            try {
              const got = await pollBranch(ports, project, branch, token);
              if (got === undefined) continue;
              if (!got.asked) kept.push(`ci:${project.id}:${branch}:`);
              else news += await report(r, ports, project, branch, branch === project.base, got.runs, seen);
            } catch (err) {
              if (!(err instanceof Unavailable)) throw err;
              failed += 1;
              kept.push(`ci:${project.id}:${branch}:`);
              notes.push(`${project.id}: ${errorMessage(err)}`);
            }
          }
          // A branch that was not read now keeps its findings; the others close when green or gone.
          let closed = 0;
          for (const f of r.findings.liveWithPrefix(ctx.org, project.id, "ci", `ci:${project.id}:`)) {
            if (seen.has(f.dedupeKey) || kept.some((k) => f.dedupeKey.startsWith(k))) continue;
            const branch = f.dedupeKey.split(":")[2] ?? "";
            closed += closeOne(r, f, branches.includes(branch));
          }
          return { news: news + closed, failed, total: branches.length };
        });
        if (used.state !== "ok") {
          notes.push(
            `${project.id}: ${used.state === "signed-out" ? `not signed in to ${remote.host}` : `the sign-in to ${remote.host} was refused`}`,
          );
          continue;
        }
        filed += used.value.news;
        if (used.value.failed === used.value.total) continue;
        looked += 1;
      }
      if (looked === 0 && notes.length > 0 && projects.length > 0) {
        const unreachable = notes.some(
          (n) => n.includes("did not answer") || n.includes("refused the token"),
        );
        if (unreachable) throw new Error(notes[0]);
      }
      return {
        findings: filed,
        note:
          looked === 0
            ? (notes[0] ?? "Nothing to look at")
            : `${looked} checked${notes.length > 0 ? `, ${notes.length} skipped` : ""}`,
      };
    },
  };
}

function closeOne(r: Reporter, f: { id: number }, branchStillOpen: boolean): number {
  try {
    const actor = { kind: "captain" as const, org: r.org };
    if (branchStillOpen) r.findings.update({ id: f.id, status: "fixed" }, actor);
    else r.findings.dismiss(f.id, "The branch is no longer an open task.", actor);
    return 1;
  } catch {
    return 0;
  }
}
