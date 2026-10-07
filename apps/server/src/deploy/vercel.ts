import type { DeployRunStep } from "@majhi/shared";
import { call, HostUnreachable, str } from "../gitConnect/http.ts";
import {
  type DeployContext,
  DeployProblem,
  type DeployProvider,
  type PreviousDeploy,
  type ProviderDeps,
  type RunHandle,
  type RunProgress,
} from "./types.ts";

/**
 * Deploy through Vercel's deployments API with the token of an `env` connection of the workspace
 * (`VERCEL_TOKEN`). A deploy is created from the project's GitHub repo at the commit; a rollback makes a
 * new deployment from the earlier one, which is exactly what ran before.
 */

export const VERCEL_TOKEN_VARIABLE = "VERCEL_TOKEN";
const API = "https://api.vercel.com";

interface Access {
  token: string;
  /** The API's address: Vercel's, or a fake one in tests. */
  base: string;
}

type VercelRun = Extract<DeployRunStep, { kind: "vercel" }>;

function vercelOf(step: DeployRunStep): VercelRun {
  if (step.kind !== "vercel") throw new DeployProblem("This run is not a Vercel project.");
  return step;
}

async function access(ctx: DeployContext, step: VercelRun, deps: ProviderDeps): Promise<Access> {
  const got = await deps.credentials.variable(ctx.org, step.connection, VERCEL_TOKEN_VARIABLE);
  if ("problem" in got) throw new DeployProblem(got.problem);
  return { token: got.value, base: deps.vercelApi ?? API };
}

async function api(deps: ProviderDeps, a: Access, path: string, json?: unknown) {
  try {
    const answer = await call(deps.fetch, `${a.base}${path}`, {
      headers: { authorization: `Bearer ${a.token}`, "user-agent": "majhi" },
      ...(json === undefined ? {} : { json }),
    });
    if (answer.status === 401 || answer.status === 403) {
      throw new DeployProblem("Vercel refused the token of the connection. Save a new VERCEL_TOKEN in it.");
    }
    return answer;
  } catch (err) {
    if (err instanceof HostUnreachable) throw new DeployProblem(err.message);
    throw err;
  }
}

function handleOf(body: unknown): RunHandle {
  const id = str(body, "id");
  if (id === undefined) throw new DeployProblem("Vercel did not name the deployment it made.");
  const inspect = str(body, "inspectorUrl");
  const url = str(body, "url");
  return { id, url: inspect ?? (url === undefined ? undefined : `https://${url}`) };
}

export function createVercelProvider(deps: ProviderDeps): DeployProvider {
  const create = async (
    ctx: DeployContext,
    via: VercelRun,
    body: Record<string, unknown>,
  ): Promise<RunHandle> => {
    const a = await access(ctx, via, deps);
    const made = await api(deps, a, "/v13/deployments?forceNew=1", {
      name: via.project,
      project: via.project,
      ...(via.target === "production" ? { target: "production" } : {}),
      ...body,
    });
    if (made.status !== 200 && made.status !== 201) {
      throw new DeployProblem(`Vercel did not create the deployment (it answered ${made.status}).`);
    }
    return handleOf(made.body);
  };

  return {
    // Vercel reads the commit from the repo itself; a commit it cannot find is its error at start.
    preflight: async () => undefined,

    async start(ctx, run) {
      const via = vercelOf(run);
      const repo = await ctx.repoOf();
      if (repo === undefined || repo.provider !== "github") {
        throw new DeployProblem(
          `${ctx.project} has no GitHub remote, so Vercel cannot deploy a commit of it.`,
        );
      }
      const [org, ...rest] = repo.slug.split("/");
      return create(ctx, via, {
        gitSource: { type: "github", org, repo: rest.join("/"), ref: ctx.base, sha: ctx.commit },
      });
    },

    async poll(ctx, step, run): Promise<RunProgress> {
      const a = await access(ctx, vercelOf(step), deps);
      const answer = await api(deps, a, `/v13/deployments/${encodeURIComponent(run.id)}`);
      if (answer.status !== 200)
        throw new DeployProblem(`Vercel answered ${answer.status} for the deployment.`);
      const state = str(answer.body, "readyState") ?? str(answer.body, "status") ?? "UNKNOWN";
      if (state === "READY") return { state: "success" };
      if (state === "ERROR" || state === "CANCELED") {
        const why = str(answer.body, "errorMessage");
        return {
          state: "failed",
          detail: `The deployment ${state.toLowerCase()}${why === undefined ? "" : `: ${why}`}`,
        };
      }
      return { state: "running" };
    },

    redeploy(ctx, step, previous: PreviousDeploy) {
      if (previous.run === undefined) {
        throw new DeployProblem("The earlier deploy has no Vercel deployment to make again.");
      }
      return create(ctx, vercelOf(step), { deploymentId: previous.run.id });
    },
  };
}
