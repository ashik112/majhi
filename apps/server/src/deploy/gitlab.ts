import type { DeployRunStep } from "@majhi/shared";
import { call, HostUnreachable, num, str } from "../gitConnect/http.ts";
import {
  apiScheme,
  type DeployContext,
  DeployProblem,
  type DeployProvider,
  type ProviderDeps,
  type RunHandle,
  type RunProgress,
} from "./types.ts";

/**
 * Deploy through a GitLab pipeline created on a branch, using the workspace's own GitLab sign-in.
 * GitLab starts a pipeline from a branch or a tag, not from a commit, so a rollback gives the earlier commit a
 * branch and runs the same pipeline (same inputs) on it; a job target runs the job that deployed it again.
 */

interface Access {
  token: string;
  base: string;
  id: string;
  slug: string;
}

type Remoted = Extract<DeployRunStep, { kind: "gitlab-pipeline" | "gitlab-job" | "gitlab-merge" }>;

function gitlabStep(step: DeployRunStep): Remoted {
  if (step.kind !== "gitlab-pipeline" && step.kind !== "gitlab-job" && step.kind !== "gitlab-merge") {
    throw new DeployProblem("This run is not a GitLab run.");
  }
  return step;
}

/** The branch a pipeline starts from: the run's own, else the project's base. A merge starts from the base. */
function ref(ctx: DeployContext, step: Remoted): string {
  return step.kind === "gitlab-pipeline" && step.ref !== "base" ? step.ref : ctx.base;
}

async function access(ctx: DeployContext, step: Remoted, deps: ProviderDeps): Promise<Access> {
  const repo = await ctx.repoOf(step.remote);
  if (repo === undefined || repo.provider !== "gitlab") {
    throw new DeployProblem(
      `The remote ${step.remote} of ${ctx.project} is not on GitLab, so a GitLab run cannot deploy it.`,
    );
  }
  const got = await deps.credentials.git(ctx.org, repo.host, "gitlab");
  if ("problem" in got) throw new DeployProblem(got.problem);
  return {
    token: got.token,
    base: `${apiScheme(repo.host)}://${repo.host}/api/v4`,
    id: encodeURIComponent(repo.slug),
    slug: repo.slug,
  };
}

async function api(
  deps: ProviderDeps,
  a: Access,
  path: string,
  json?: unknown,
  method?: "PUT",
): Promise<{ status: number; body: unknown }> {
  try {
    const answer = await call(deps.fetch, `${a.base}${path}`, {
      headers: { authorization: `Bearer ${a.token}`, "user-agent": "majhi" },
      ...(json === undefined ? {} : { json }),
      ...(method === undefined ? {} : { method }),
    });
    if (answer.status === 401 || answer.status === 403) {
      throw new DeployProblem(
        "GitLab refused the workspace's sign-in. Sign the workspace in to GitLab again.",
      );
    }
    return answer;
  } catch (err) {
    if (err instanceof HostUnreachable) throw new DeployProblem(err.message);
    throw err;
  }
}

const RUNNING = new Set([
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "scheduled",
  "manual",
]);

/** A job in these states was played already and is going or done well: it is followed, never played again. */
const PLAYED = new Set([
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "scheduled",
  "success",
]);

const JOB_FIND_TRIES = 8;
const JOB_FIND_WAIT_MS = 2_000;

/** The pipeline of the commit: the newest one the host has, or a new one on the base branch. */
async function pipelineOf(ctx: DeployContext, step: Remoted, a: Access, deps: ProviderDeps): Promise<string> {
  const found = await api(
    deps,
    a,
    `/projects/${a.id}/pipelines?sha=${encodeURIComponent(ctx.commit)}&order_by=id&sort=desc&per_page=1`,
  );
  const first = Array.isArray(found.body) ? found.body[0] : undefined;
  const known = num(first, "id");
  if (known !== undefined) return String(known);
  const made = await api(deps, a, `/projects/${a.id}/pipeline`, { ref: ref(ctx, step) });
  const id = num(made.body, "id");
  if (made.status !== 201 || id === undefined) {
    throw new DeployProblem(
      `GitLab did not create a pipeline for ${ctx.commit.slice(0, 7)} (it answered ${made.status}).`,
    );
  }
  return String(id);
}

interface Job {
  id: number;
  status: string;
  url: string | undefined;
}

/** The job of that name in the pipeline: the newest when it was retried. A new pipeline needs a moment to list its jobs. */
async function jobOf(
  name: string,
  pipeline: string,
  a: Access,
  deps: ProviderDeps,
): Promise<Job | undefined> {
  for (let i = 0; i < JOB_FIND_TRIES; i++) {
    const listed = await api(deps, a, `/projects/${a.id}/pipelines/${pipeline}/jobs?per_page=100`);
    const jobs = Array.isArray(listed.body) ? (listed.body as unknown[]) : [];
    const mine = jobs
      .filter((j) => str(j, "name") === name)
      .map((j) => ({ id: num(j, "id"), status: str(j, "status") ?? "unknown", url: str(j, "web_url") }))
      .filter((j): j is Job => j.id !== undefined)
      .sort((x, y) => y.id - x.id)[0];
    if (mine !== undefined) return mine;
    if (i < JOB_FIND_TRIES - 1) await deps.sleep(JOB_FIND_WAIT_MS);
  }
  return undefined;
}

/** Runs a job again (a failed one, or the job that deployed an earlier commit): GitLab makes a new job of it. */
async function retryJob(a: Access, id: number, deps: ProviderDeps): Promise<RunHandle> {
  const again = await api(deps, a, `/projects/${a.id}/jobs/${id}/retry`, {});
  const newId = num(again.body, "id");
  if ((again.status !== 200 && again.status !== 201) || newId === undefined) {
    throw new DeployProblem(`GitLab did not run the job again (it answered ${again.status}).`);
  }
  return { id: String(newId), url: str(again.body, "web_url") };
}

const jobHandle = (job: Job): RunHandle => ({ id: String(job.id), url: job.url });

const MERGE_TRIES = 10;
const MERGE_WAIT_MS = 3_000;

/**
 * Brings the commit into the environment's branch through a merge request from the base branch, then
 * finds the pipeline GitLab runs on the result. Merged only while the base branch is still at the commit
 * (GitLab checks `sha`), never forced. A branch that has the commit already gets its newest pipeline.
 */
async function mergeInto(
  ctx: DeployContext,
  step: Extract<DeployRunStep, { kind: "gitlab-merge" }>,
  a: Access,
  deps: ProviderDeps,
): Promise<RunHandle> {
  const branch = encodeURIComponent(step.branch);
  const compare = await api(
    deps,
    a,
    `/projects/${a.id}/repository/compare?from=${branch}&to=${encodeURIComponent(ctx.commit)}&straight=true`,
  );
  const missing = (compare.body as { commits?: unknown[] } | undefined)?.commits;
  if (compare.status === 200 && Array.isArray(missing) && missing.length === 0) {
    const tip = await api(deps, a, `/projects/${a.id}/repository/branches/${branch}`);
    const head = str((tip.body as { commit?: unknown } | undefined)?.commit, "id");
    if (head === undefined) throw new DeployProblem(`GitLab has no branch ${step.branch} in ${a.slug}.`);
    return pipelineOn(step.branch, head, a, deps);
  }
  const source = encodeURIComponent(ctx.base);
  const open = await api(
    deps,
    a,
    `/projects/${a.id}/merge_requests?state=opened&source_branch=${source}&target_branch=${branch}&per_page=1`,
  );
  let iid = Array.isArray(open.body) ? num(open.body[0], "iid") : undefined;
  if (iid === undefined) {
    const made = await api(deps, a, `/projects/${a.id}/merge_requests`, {
      source_branch: ctx.base,
      target_branch: step.branch,
      title: `Deploy ${ctx.commit.slice(0, 7)} to ${ctx.env.env}`,
      remove_source_branch: false,
    });
    iid = num(made.body, "iid");
    if (made.status !== 201 || iid === undefined)
      throw new DeployProblem(
        `GitLab did not open a merge request from ${ctx.base} into ${step.branch} (it answered ${made.status}).`,
      );
  }
  // A new merge request needs a moment before GitLab knows it can merge.
  for (let i = 0; i < MERGE_TRIES; i++) {
    const merged = await api(
      deps,
      a,
      `/projects/${a.id}/merge_requests/${iid}/merge`,
      { sha: ctx.commit, should_remove_source_branch: false },
      "PUT",
    );
    if (merged.status === 200) {
      const head = str(merged.body, "merge_commit_sha") ?? str(merged.body, "sha") ?? ctx.commit;
      return pipelineOn(step.branch, head, a, deps);
    }
    if (merged.status === 409)
      throw new DeployProblem(
        `${ctx.base} moved past ${ctx.commit.slice(0, 7)} on GitLab. Plan the deploy again.`,
      );
    if (merged.status !== 405 && merged.status !== 406 && merged.status !== 422)
      throw new DeployProblem(
        `GitLab did not merge ${ctx.base} into ${step.branch} (it answered ${merged.status}).`,
      );
    if (i < MERGE_TRIES - 1) await deps.sleep(MERGE_WAIT_MS);
  }
  throw new DeployProblem(
    `GitLab cannot merge ${ctx.base} into ${step.branch}: they conflict, or the merge request waits on something. See merge request !${iid}.`,
  );
}

/** The pipeline GitLab runs on `branch` at `head`. A push needs a moment to start one. */
async function pipelineOn(branch: string, head: string, a: Access, deps: ProviderDeps): Promise<RunHandle> {
  for (let i = 0; i < JOB_FIND_TRIES; i++) {
    const found = await api(
      deps,
      a,
      `/projects/${a.id}/pipelines?ref=${encodeURIComponent(branch)}&sha=${encodeURIComponent(head)}&order_by=id&sort=desc&per_page=1`,
    );
    const first = Array.isArray(found.body) ? found.body[0] : undefined;
    const id = num(first, "id");
    if (id !== undefined) return { id: String(id), url: str(first, "web_url") };
    if (i < JOB_FIND_TRIES - 1) await deps.sleep(JOB_FIND_WAIT_MS);
  }
  throw new DeployProblem(
    `${branch} is at ${head.slice(0, 7)} on GitLab, but GitLab started no pipeline on it.`,
  );
}

export function createGitLabProvider(deps: ProviderDeps): DeployProvider {
  return {
    async preflight(ctx, run) {
      const step = gitlabStep(run);
      const a = await access(ctx, step, deps);
      const branch = ref(ctx, step);
      const answer = await api(
        deps,
        a,
        `/projects/${a.id}/repository/branches/${encodeURIComponent(branch)}`,
      );
      const tip =
        answer.status === 200
          ? str((answer.body as { commit?: unknown } | undefined)?.commit, "id")
          : undefined;
      if (tip === undefined) return `GitLab has no branch ${branch} in ${a.slug}. Push it first.`;
      return tip === ctx.commit
        ? undefined
        : `GitLab has ${branch} at ${tip.slice(0, 7)}, not at ${ctx.commit.slice(0, 7)}. Push it first.`;
    },

    async start(ctx, run) {
      const step = gitlabStep(run);
      const a = await access(ctx, step, deps);
      if (step.kind === "gitlab-merge") return mergeInto(ctx, step, a, deps);
      if (step.kind === "gitlab-job") {
        const pipeline = await pipelineOf(ctx, step, a, deps);
        const job = await jobOf(step.job, pipeline, a, deps);
        if (job === undefined) {
          throw new DeployProblem(`The pipeline ${pipeline} of ${a.slug} has no job named ${step.job}.`);
        }
        // Played already (a second start of the same step): follow it, never play twice.
        if (PLAYED.has(job.status)) return jobHandle(job);
        if (job.status === "manual") {
          const variables = Object.entries(step.variables ?? {}).map(([key, value]) => ({ key, value }));
          const played = await api(deps, a, `/projects/${a.id}/jobs/${job.id}/play`, {
            ...(variables.length === 0 ? {} : { job_variables_attributes: variables }),
          });
          if (played.status !== 200 && played.status !== 201) {
            throw new DeployProblem(`GitLab did not play ${step.job} (it answered ${played.status}).`);
          }
          return jobHandle({ ...job, url: str(played.body, "web_url") ?? job.url });
        }
        // Failed or canceled before: run it again.
        return retryJob(a, job.id, deps);
      }
      const variables = Object.entries(step.variables ?? {}).map(([key, value]) => ({ key, value }));
      const made = await api(deps, a, `/projects/${a.id}/pipeline`, {
        ref: ref(ctx, step),
        ...(variables.length === 0 ? {} : { variables }),
      });
      const id = num(made.body, "id");
      if (made.status !== 201 || id === undefined) {
        throw new DeployProblem(`GitLab did not create the pipeline (it answered ${made.status}).`);
      }
      return { id: String(id), url: str(made.body, "web_url") };
    },

    async poll(ctx, run, handle): Promise<RunProgress> {
      const step = gitlabStep(run);
      const a = await access(ctx, step, deps);
      if (step.kind === "gitlab-job") {
        const answer = await api(deps, a, `/projects/${a.id}/jobs/${encodeURIComponent(handle.id)}`);
        if (answer.status !== 200) throw new DeployProblem(`GitLab answered ${answer.status} for the job.`);
        const status = str(answer.body, "status") ?? "unknown";
        if (status === "success") return { state: "success" };
        if (RUNNING.has(status)) return { state: "running" };
        return { state: "failed", detail: `The job ${step.job} ${status.replaceAll("_", " ")}` };
      }
      const answer = await api(deps, a, `/projects/${a.id}/pipelines/${encodeURIComponent(handle.id)}`);
      if (answer.status !== 200)
        throw new DeployProblem(`GitLab answered ${answer.status} for the pipeline.`);
      const status = str(answer.body, "status") ?? "unknown";
      if (status === "success") return { state: "success" };
      if (RUNNING.has(status)) return { state: "running" };
      return { state: "failed", detail: `The pipeline ${status.replaceAll("_", " ")}` };
    },

    // A job of the commit's pipeline is run again. A pipeline starts from a branch, so the earlier commit gets a
    // branch of its own (named by the commit, made once) and the same pipeline, with the same inputs, runs on it.
    async redeploy(ctx, run, previous) {
      const step = gitlabStep(run);
      if (step.kind === "gitlab-merge")
        throw new DeployProblem(
          `A merge into ${step.branch} cannot go back: majhi never rewinds a branch. Revert on the base branch and deploy again.`,
        );
      const a = await access(ctx, step, deps);
      if (step.kind === "gitlab-job") {
        if (previous.run === undefined)
          throw new DeployProblem("The earlier deploy has no GitLab job to run again.");
        return retryJob(a, Number(previous.run.id), deps);
      }
      const branch = `majhi-rollback-${previous.commit.slice(0, 12)}`;
      const made = await api(deps, a, `/projects/${a.id}/repository/branches`, {
        branch,
        ref: previous.commit,
      });
      // 400 is "the branch exists": an earlier rollback to this commit made it.
      if (made.status !== 201 && made.status !== 400) {
        throw new DeployProblem(
          `GitLab would not make a branch at ${previous.commit.slice(0, 7)} (it answered ${made.status}).`,
        );
      }
      const variables = Object.entries(step.variables ?? {}).map(([key, value]) => ({ key, value }));
      const started = await api(deps, a, `/projects/${a.id}/pipeline`, {
        ref: branch,
        ...(variables.length === 0 ? {} : { variables }),
      });
      const id = num(started.body, "id");
      if (started.status !== 201 || id === undefined) {
        throw new DeployProblem(`GitLab did not run the pipeline again (it answered ${started.status}).`);
      }
      return { id: String(id), url: str(started.body, "web_url") };
    },
  };
}
