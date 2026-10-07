import { call, HostUnreachable, num, str } from "../gitConnect/http.ts";
import {
  apiScheme,
  type DeployContext,
  DeployProblem,
  type DeployProvider,
  type ProviderDeps,
  type RunProgress,
} from "./types.ts";

/**
 * Deploy through a GitLab pipeline created on a branch, using the workspace's own GitLab sign-in.
 * GitLab starts a pipeline from a branch or a tag, not from a commit, so a rollback cannot start the
 * earlier commit again: the owner writes the rollback for these targets (the project's setup says so).
 */

interface Access {
  token: string;
  base: string;
  id: string;
}

function ref(ctx: DeployContext): string {
  const via = ctx.target.via;
  return via.kind === "gitlab-pipeline" && via.ref !== "base" ? via.ref : ctx.base;
}

async function access(ctx: DeployContext, deps: ProviderDeps): Promise<Access> {
  const via = ctx.target.via;
  if (via.kind !== "gitlab-pipeline") throw new DeployProblem("This target is not a GitLab pipeline.");
  if (ctx.repo === undefined || ctx.repo.provider !== "gitlab") {
    throw new DeployProblem(`${ctx.project} has no GitLab remote, so a GitLab pipeline cannot deploy it.`);
  }
  const got = await deps.credentials.git(ctx.org, via.connection, "gitlab");
  if ("problem" in got) throw new DeployProblem(got.problem);
  return {
    token: got.token,
    base: `${apiScheme(got.host)}://${got.host}/api/v4`,
    id: encodeURIComponent(ctx.repo.slug),
  };
}

async function api(
  deps: ProviderDeps,
  a: Access,
  path: string,
  json?: unknown,
): Promise<{ status: number; body: unknown }> {
  try {
    const answer = await call(deps.fetch, `${a.base}${path}`, {
      headers: { authorization: `Bearer ${a.token}`, "user-agent": "majhi" },
      ...(json === undefined ? {} : { json }),
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

export function createGitLabProvider(deps: ProviderDeps): DeployProvider {
  return {
    async preflight(ctx) {
      const a = await access(ctx, deps);
      const branch = ref(ctx);
      const answer = await api(
        deps,
        a,
        `/projects/${a.id}/repository/branches/${encodeURIComponent(branch)}`,
      );
      const tip =
        answer.status === 200
          ? str((answer.body as { commit?: unknown } | undefined)?.commit, "id")
          : undefined;
      if (tip === undefined)
        return `GitLab has no branch ${branch} in ${ctx.repo?.slug ?? ctx.project}. Push it first.`;
      return tip === ctx.commit
        ? undefined
        : `GitLab has ${branch} at ${tip.slice(0, 7)}, not at ${ctx.commit.slice(0, 7)}. Push it first.`;
    },

    async start(ctx) {
      const a = await access(ctx, deps);
      const via = ctx.target.via;
      if (via.kind !== "gitlab-pipeline") throw new DeployProblem("This target is not a GitLab pipeline.");
      const variables = Object.entries(via.variables ?? {}).map(([key, value]) => ({ key, value }));
      const made = await api(deps, a, `/projects/${a.id}/pipeline`, {
        ref: ref(ctx),
        ...(variables.length === 0 ? {} : { variables }),
      });
      const id = num(made.body, "id");
      if (made.status !== 201 || id === undefined) {
        throw new DeployProblem(`GitLab did not create the pipeline (it answered ${made.status}).`);
      }
      return { id: String(id), url: str(made.body, "web_url") };
    },

    async poll(ctx, run): Promise<RunProgress> {
      const a = await access(ctx, deps);
      const answer = await api(deps, a, `/projects/${a.id}/pipelines/${encodeURIComponent(run.id)}`);
      if (answer.status !== 200)
        throw new DeployProblem(`GitLab answered ${answer.status} for the pipeline.`);
      const status = str(answer.body, "status") ?? "unknown";
      if (status === "success") return { state: "success" };
      if (RUNNING.has(status)) return { state: "running" };
      return { state: "failed", detail: `The pipeline ${status.replaceAll("_", " ")}` };
    },
  };
}
