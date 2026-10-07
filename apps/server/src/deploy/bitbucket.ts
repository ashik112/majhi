import type { DeployRunStep } from "@majhi/shared";
import { z } from "zod";
import { call, HostUnreachable } from "../gitConnect/http.ts";
import { bitbucketAuth } from "../gitConnect/oauth.ts";
import {
  type DeployContext,
  DeployProblem,
  type DeployProvider,
  type ProviderDeps,
  type RunHandle,
  type RunProgress,
} from "./types.ts";

/**
 * Deploy through a custom pipeline of Bitbucket Cloud, started on a commit with the workspace's own Bitbucket
 * sign-in. Bitbucket's REST API starts whole pipelines only: there is no call that plays one manual step of a
 * pipeline (the pipelines group of https://api.bitbucket.org/swagger.json has none), so a manual deployment
 * step is not a kind of run. A custom pipeline starts at a commit, so a rollback starts it again at the earlier one.
 */

const API = "https://api.bitbucket.org/2.0";

interface Access {
  token: string;
  /** `workspace/repo`, as the API addresses it. */
  slug: string;
}

type BitbucketRun = Extract<DeployRunStep, { kind: "bitbucket-pipeline" }>;

function bitbucketStep(step: DeployRunStep): BitbucketRun {
  if (step.kind !== "bitbucket-pipeline") throw new DeployProblem("This run is not a Bitbucket run.");
  return step;
}

/** The branch a pipeline starts from: the run's own, else the project's base. */
const branchOf = (ctx: DeployContext, step: BitbucketRun): string =>
  step.ref === "base" ? ctx.base : step.ref;

async function access(ctx: DeployContext, step: BitbucketRun, deps: ProviderDeps): Promise<Access> {
  const repo = await ctx.repoOf(step.remote);
  if (repo === undefined || repo.provider !== "bitbucket") {
    throw new DeployProblem(
      `The remote ${step.remote} of ${ctx.project} is not on Bitbucket, so a Bitbucket run cannot deploy it.`,
    );
  }
  if (repo.host !== "bitbucket.org") {
    throw new DeployProblem(`Pipelines runs are for Bitbucket Cloud, and ${repo.host} is not bitbucket.org.`);
  }
  const got = await deps.credentials.git(ctx.org, repo.host, "bitbucket");
  if ("problem" in got) throw new DeployProblem(got.problem);
  return { token: got.token, slug: repo.slug };
}

async function api(
  deps: ProviderDeps,
  a: Access,
  path: string,
  json?: unknown,
): Promise<{ status: number; body: unknown }> {
  try {
    const answer = await call(deps.fetch, `${API}/repositories/${a.slug}${path}`, {
      headers: { authorization: bitbucketAuth(a.token), "user-agent": "majhi" },
      ...(json === undefined ? {} : { json }),
    });
    if (answer.status === 401 || answer.status === 403) {
      throw new DeployProblem(
        "Bitbucket refused the workspace's sign-in. Sign the workspace in to Bitbucket again with a token that can run pipelines.",
      );
    }
    return answer;
  } catch (err) {
    if (err instanceof HostUnreachable) throw new DeployProblem(err.message);
    throw err;
  }
}

const PipelineSchema = z.object({
  uuid: z.string(),
  build_number: z.number().optional(),
  state: z
    .object({
      name: z.string(),
      stage: z.object({ name: z.string() }).partial().optional(),
      result: z.object({ name: z.string() }).partial().optional(),
    })
    .optional(),
  target: z
    .object({
      commit: z.object({ hash: z.string() }).partial().optional(),
      selector: z.object({ pattern: z.string() }).partial().optional(),
    })
    .optional(),
});
type Pipeline = z.infer<typeof PipelineSchema>;

const PageSchema = z.object({ values: z.array(z.unknown()).default([]) });

function pipelineOf(body: unknown): Pipeline | undefined {
  const parsed = PipelineSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

const handleOf = (a: Access, p: Pipeline): RunHandle => ({
  id: p.uuid,
  ...(p.build_number === undefined
    ? {}
    : { url: `https://bitbucket.org/${a.slug}/pipelines/results/${p.build_number}` }),
});

/** A pipeline that has not ended is the run of a start that was made already. */
const IN_FLIGHT = new Set(["PENDING", "IN_PROGRESS"]);

/** How many of the repo's newest pipelines are looked at for one that is already going. */
const RECENT = 30;

async function inFlight(
  ctx: DeployContext,
  step: BitbucketRun,
  a: Access,
  deps: ProviderDeps,
): Promise<Pipeline | undefined> {
  const listed = await api(deps, a, `/pipelines/?sort=-created_on&pagelen=${RECENT}`);
  if (listed.status !== 200) return undefined;
  const page = PageSchema.safeParse(listed.body);
  if (!page.success) return undefined;
  return page.data.values
    .map(pipelineOf)
    .find(
      (p) =>
        p !== undefined &&
        IN_FLIGHT.has(p.state?.name ?? "") &&
        p.target?.commit?.hash === ctx.commit &&
        p.target.selector?.pattern === step.pipeline,
    );
}

/** Starts the custom pipeline on the commit, in the context of its branch. */
async function launch(ctx: DeployContext, step: BitbucketRun, a: Access, deps: ProviderDeps) {
  const variables = Object.entries(step.variables ?? {}).map(([key, value]) => ({ key, value }));
  const made = await api(deps, a, "/pipelines/", {
    target: {
      type: "pipeline_ref_target",
      ref_type: "branch",
      ref_name: branchOf(ctx, step),
      commit: { type: "commit", hash: ctx.commit },
      selector: { type: "custom", pattern: step.pipeline },
    },
    ...(variables.length === 0 ? {} : { variables }),
  });
  const pipeline = made.status === 201 || made.status === 200 ? pipelineOf(made.body) : undefined;
  if (pipeline === undefined) {
    throw new DeployProblem(
      `Bitbucket did not start the pipeline ${step.pipeline} in ${a.slug} (it answered ${made.status}).`,
    );
  }
  return handleOf(a, pipeline);
}

export function createBitbucketProvider(deps: ProviderDeps): DeployProvider {
  return {
    async preflight(ctx, run) {
      const step = bitbucketStep(run);
      const a = await access(ctx, step, deps);
      const branch = branchOf(ctx, step);
      const answer = await api(deps, a, `/refs/branches/${encodeURIComponent(branch)}`);
      const target = (answer.body as { target?: { hash?: unknown } } | undefined)?.target;
      const tip = answer.status === 200 && typeof target?.hash === "string" ? target.hash : undefined;
      if (tip === undefined) return `Bitbucket has no branch ${branch} in ${a.slug}. Push it first.`;
      return tip === ctx.commit
        ? undefined
        : `Bitbucket has ${branch} at ${tip.slice(0, 7)}, not at ${ctx.commit.slice(0, 7)}. Push it first.`;
    },

    async start(ctx, run) {
      const step = bitbucketStep(run);
      const a = await access(ctx, step, deps);
      // Started already (a second start of the same step): follow it, never start twice.
      const going = await inFlight(ctx, step, a, deps);
      return going === undefined ? launch(ctx, step, a, deps) : handleOf(a, going);
    },

    async poll(ctx, run, handle): Promise<RunProgress> {
      const step = bitbucketStep(run);
      const a = await access(ctx, step, deps);
      const answer = await api(deps, a, `/pipelines/${encodeURIComponent(handle.id)}`);
      const pipeline = answer.status === 200 ? pipelineOf(answer.body) : undefined;
      if (pipeline === undefined) {
        throw new DeployProblem(`Bitbucket answered ${answer.status} for the pipeline.`);
      }
      const state = pipeline.state?.name ?? "unknown";
      if (state === "COMPLETED") {
        const result = pipeline.state?.result?.name ?? "unknown";
        return result === "SUCCESSFUL"
          ? { state: "success" }
          : { state: "failed", detail: `The pipeline ${step.pipeline} ${String(result).toLowerCase()}` };
      }
      // A pipeline that waits for someone to play a manual step in Bitbucket does not end by itself.
      if (pipeline.state?.stage?.name === "PAUSED") {
        return { state: "failed", detail: `The pipeline ${step.pipeline} is waiting for a manual step` };
      }
      return IN_FLIGHT.has(state)
        ? { state: "running" }
        : { state: "failed", detail: `The pipeline ${step.pipeline} is ${state.toLowerCase()}` };
    },

    // A custom pipeline starts at a commit, so going back starts it again at the earlier one, with the same variables.
    async redeploy(ctx, run) {
      const step = bitbucketStep(run);
      return launch(ctx, step, await access(ctx, step, deps), deps);
    },
  };
}
