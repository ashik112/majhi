import { call, HostUnreachable, num, str } from "../gitConnect/http.ts";
import {
  apiScheme,
  type DeployContext,
  DeployProblem,
  type DeployProvider,
  type PreviousDeploy,
  type ProviderDeps,
  type RunHandle,
} from "./types.ts";

/**
 * Deploy through a GitHub Actions workflow with `workflow_dispatch`, using the workspace's own GitHub
 * sign-in. Starting finds the run the dispatch made (the newest one for this commit since the call);
 * a rollback runs the earlier successful run again, which redeploys exactly the commit it ran at.
 */

const FIND_TRIES = 12;
const FIND_WAIT_MS = 2_500;
/** A run may be stamped a little before the clock of this machine says the call was made. */
const SKEW_MS = 10_000;

interface Access {
  token: string;
  base: string;
  slug: string;
}

function ref(ctx: DeployContext): string {
  const via = ctx.target.via;
  return via.kind === "github-workflow" && via.ref !== "base" ? via.ref : ctx.base;
}

async function access(ctx: DeployContext, deps: ProviderDeps): Promise<Access> {
  const via = ctx.target.via;
  if (via.kind !== "github-workflow") throw new DeployProblem("This target is not a GitHub workflow.");
  if (ctx.repo === undefined || ctx.repo.provider !== "github") {
    throw new DeployProblem(`${ctx.project} has no GitHub remote, so a GitHub workflow cannot deploy it.`);
  }
  const got = await deps.credentials.git(ctx.org, via.connection, "github");
  if ("problem" in got) throw new DeployProblem(got.problem);
  const host = got.host;
  const base = host === "github.com" ? "https://api.github.com" : `${apiScheme(host)}://${host}/api/v3`;
  return { token: got.token, base, slug: ctx.repo.slug };
}

const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "majhi",
});

async function api(
  deps: ProviderDeps,
  a: Access,
  path: string,
  req: { method?: "GET" | "POST"; json?: unknown } = {},
) {
  try {
    const answer = await call(deps.fetch, `${a.base}${path}`, {
      headers: headers(a.token),
      ...(req.method === undefined ? {} : { method: req.method }),
      ...(req.json === undefined ? {} : { json: req.json }),
    });
    if (answer.status === 401 || answer.status === 403) {
      throw new DeployProblem(
        "GitHub refused the workspace's sign-in. Sign the workspace in to GitHub again.",
      );
    }
    return answer;
  } catch (err) {
    if (err instanceof HostUnreachable) throw new DeployProblem(err.message);
    throw err;
  }
}

function runsOf(body: unknown): { id: number; head_sha: string; created_at: string; html_url: string }[] {
  if (typeof body !== "object" || body === null) return [];
  const list = (body as { workflow_runs?: unknown }).workflow_runs;
  if (!Array.isArray(list)) return [];
  const out: { id: number; head_sha: string; created_at: string; html_url: string }[] = [];
  for (const r of list) {
    const id = num(r, "id");
    const head = str(r, "head_sha");
    const at = str(r, "created_at");
    if (id !== undefined && head !== undefined && at !== undefined) {
      out.push({ id, head_sha: head, created_at: at, html_url: str(r, "html_url") ?? "" });
    }
  }
  return out;
}

export function createGitHubProvider(deps: ProviderDeps): DeployProvider {
  const segment = (text: string) => encodeURIComponent(text);

  return {
    async preflight(ctx) {
      const a = await access(ctx, deps);
      const branch = ref(ctx);
      const answer = await api(deps, a, `/repos/${a.slug}/branches/${segment(branch)}`);
      const tip =
        answer.status === 200
          ? str((answer.body as { commit?: unknown } | undefined)?.commit, "sha")
          : undefined;
      if (tip === undefined) return `GitHub has no branch ${branch} in ${a.slug}. Push it first.`;
      return tip === ctx.commit
        ? undefined
        : `GitHub has ${branch} at ${tip.slice(0, 7)}, not at ${ctx.commit.slice(0, 7)}. Push it first.`;
    },

    async start(ctx) {
      const a = await access(ctx, deps);
      const via = ctx.target.via;
      if (via.kind !== "github-workflow") throw new DeployProblem("This target is not a GitHub workflow.");
      const branch = ref(ctx);
      const since = deps.now().getTime() - SKEW_MS;
      const file = segment(via.workflow);
      const sent = await api(deps, a, `/repos/${a.slug}/actions/workflows/${file}/dispatches`, {
        method: "POST",
        json: { ref: branch, ...(via.inputs === undefined ? {} : { inputs: via.inputs }) },
      });
      if (sent.status !== 204 && sent.status !== 200) {
        throw new DeployProblem(
          `GitHub did not start ${via.workflow} on ${branch} (it answered ${sent.status}). Check the workflow has workflow_dispatch and the file name is right.`,
        );
      }
      for (let i = 0; i < FIND_TRIES; i++) {
        const listed = await api(
          deps,
          a,
          `/repos/${a.slug}/actions/workflows/${file}/runs?event=workflow_dispatch&branch=${segment(branch)}&per_page=10`,
        );
        const mine = runsOf(listed.body)
          .filter((r) => r.head_sha === ctx.commit && Date.parse(r.created_at) >= since)
          .sort((x, y) => y.id - x.id)[0];
        if (mine !== undefined) return { id: String(mine.id), url: mine.html_url, attempt: 1 };
        await deps.sleep(FIND_WAIT_MS);
      }
      throw new DeployProblem(
        `GitHub accepted ${via.workflow} but no run for ${ctx.commit.slice(0, 7)} appeared.`,
      );
    },

    async poll(ctx, run) {
      const a = await access(ctx, deps);
      const answer = await api(deps, a, `/repos/${a.slug}/actions/runs/${segment(run.id)}`);
      if (answer.status !== 200) throw new DeployProblem(`GitHub answered ${answer.status} for the run.`);
      const attempt = num(answer.body, "run_attempt") ?? 1;
      // A rerun keeps its id: until the new attempt exists, what the run says is the old one's.
      if (run.attempt !== undefined && attempt < run.attempt) return { state: "running" };
      if (str(answer.body, "status") !== "completed") return { state: "running" };
      const conclusion = str(answer.body, "conclusion") ?? "unknown";
      if (conclusion === "success") return { state: "success" };
      return { state: "failed", detail: await failure(deps, a, run, conclusion) };
    },

    async redeploy(ctx, previous: PreviousDeploy): Promise<RunHandle> {
      const a = await access(ctx, deps);
      const run = previous.run;
      if (run === undefined) {
        throw new DeployProblem("The earlier deploy has no workflow run to run again.");
      }
      const before = await api(deps, a, `/repos/${a.slug}/actions/runs/${segment(run.id)}`);
      const attempt = (num(before.body, "run_attempt") ?? 1) + 1;
      const sent = await api(deps, a, `/repos/${a.slug}/actions/runs/${segment(run.id)}/rerun`, {
        method: "POST",
      });
      if (sent.status !== 201 && sent.status !== 200) {
        throw new DeployProblem(
          `GitHub did not run the earlier workflow again (it answered ${sent.status}).`,
        );
      }
      return { id: run.id, url: run.url, attempt };
    },
  };
}

/** What failed, in a sentence: the conclusion, and the job and step that failed when the host says. */
async function failure(deps: ProviderDeps, a: Access, run: RunHandle, conclusion: string): Promise<string> {
  const head = `The workflow run ${conclusion}`;
  try {
    const jobs = await api(deps, a, `/repos/${a.slug}/actions/runs/${encodeURIComponent(run.id)}/jobs`);
    const list = (jobs.body as { jobs?: unknown } | undefined)?.jobs;
    if (!Array.isArray(list)) return head;
    for (const job of list) {
      if (str(job, "conclusion") !== "failure") continue;
      const steps = (job as { steps?: unknown }).steps;
      const step = Array.isArray(steps) ? steps.find((s) => str(s, "conclusion") === "failure") : undefined;
      const stepName = step === undefined ? undefined : str(step, "name");
      return `${head}: job ${str(job, "name") ?? "?"}${stepName === undefined ? "" : `, step ${stepName}`}`;
    }
  } catch {
    // The job list only adds detail.
  }
  return head;
}
