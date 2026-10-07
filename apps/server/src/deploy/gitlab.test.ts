import type { DeployRunStep } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { createGitLabProvider } from "./gitlab.ts";
import type { DeployContext, ProviderDeps } from "./types.ts";

/** A GitLab that holds one pipeline with one manual job, and answers what the provider asks. */
function gitlab(over: { pipelines?: boolean; status?: string } = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const job = {
    id: 55,
    name: "deploy-prod",
    status: over.status ?? "manual",
    web_url: "http://gl.test/jobs/55",
  };
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: `${u.pathname}${u.search}`, body });
    const reply = (status: number, json: unknown) =>
      new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    const path = u.pathname.replace("/api/v4/projects/acme%2Fstorefront", "");
    if (method === "GET" && path === "/pipelines")
      return reply(200, over.pipelines === false ? [] : [{ id: 9 }]);
    if (method === "POST" && path === "/repository/branches") return reply(201, { name: "made" });
    if (method === "POST" && path === "/pipeline")
      return reply(201, { id: 10, web_url: "http://gl.test/p/10" });
    if (method === "GET" && /^\/pipelines\/\d+\/jobs$/.test(path)) return reply(200, [job]);
    if (method === "POST" && path === "/jobs/55/play") {
      job.status = "pending";
      return reply(200, { ...job });
    }
    if (method === "POST" && path === "/jobs/55/retry")
      return reply(201, { id: 56, web_url: "http://gl.test/jobs/56" });
    if (method === "GET" && path === "/jobs/55") return reply(200, { ...job });
    return reply(404, {});
  }) as typeof fetch;
  const deps: ProviderDeps = {
    fetch: fetchFake,
    credentials: {
      git: async () => ({ token: "gl-token" }),
      variable: async () => ({ problem: "none" }),
      ssh: async () => ({ problem: "none" }),
    },
    remote: async () => ({ code: 0, output: "" }),
    sleep: async () => undefined,
    now: () => new Date(),
  };
  const ctx: DeployContext = {
    org: "acme",
    project: "storefront",
    env: { env: "production", tier: "production" },
    base: "main",
    commit: "1".repeat(40),
    repoOf: async () => ({ provider: "gitlab", slug: "acme/storefront", host: "gl.test" }),
  };
  return { provider: createGitLabProvider(deps), ctx, calls, job };
}

const step: DeployRunStep = {
  kind: "gitlab-job",
  remote: "origin",
  job: "deploy-prod",
  variables: { VERSION: "1.8.3" },
};

describe("the gitlab-job provider", () => {
  it("plays the manual job of the commit's pipeline once, with its variables, and a retry finds it played", async () => {
    const { provider, ctx, calls } = gitlab();
    const first = await provider.start(ctx, step);
    expect(first.id).toBe("55");
    const plays = () => calls.filter((c) => c.path.endsWith("/jobs/55/play"));
    expect(plays()).toHaveLength(1);
    expect(plays()[0]?.body).toEqual({ job_variables_attributes: [{ key: "VERSION", value: "1.8.3" }] });
    // The same step again (a retry of the record): the job is already going, so it is followed, not played again.
    const again = await provider.start(ctx, step);
    expect(again.id).toBe("55");
    expect(plays()).toHaveLength(1);
  });

  it("creates the pipeline when the commit has none, and follows the job to its end", async () => {
    const { provider, ctx, calls, job } = gitlab({ pipelines: false });
    const handle = await provider.start(ctx, step);
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/pipeline"))).toBe(true);
    expect(await provider.poll(ctx, step, handle)).toEqual({ state: "running" });
    job.status = "failed";
    expect(await provider.poll(ctx, step, handle)).toMatchObject({ state: "failed" });
    job.status = "success";
    expect(await provider.poll(ctx, step, handle)).toEqual({ state: "success" });
  });

  it("runs the job of an earlier commit again to go back", async () => {
    const { provider, ctx } = gitlab({ status: "success" });
    const back = await provider.redeploy?.(ctx, step, { commit: "2".repeat(40), run: { id: "55" } });
    expect(back?.id).toBe("56");
  });

  it("goes back on a pipeline target: the earlier commit gets a branch and the same pipeline runs there with its inputs", async () => {
    const { provider, ctx, calls } = gitlab();
    const pipeline: DeployRunStep = { kind: "gitlab-pipeline", remote: "origin", ref: "base", variables: { VERSION: "1.8.2" } };
    const previous = "2".repeat(40);
    const back = await provider.redeploy?.(ctx, pipeline, { commit: previous, run: undefined });
    expect(back?.id).toBe("10");
    const branch = calls.find((c) => c.path.endsWith("/repository/branches"));
    expect(branch?.body).toEqual({ branch: `majhi-rollback-${previous.slice(0, 12)}`, ref: previous });
    const started = calls.find((c) => c.method === "POST" && c.path.endsWith("/pipeline"));
    expect(started?.body).toEqual({
      ref: `majhi-rollback-${previous.slice(0, 12)}`,
      variables: [{ key: "VERSION", value: "1.8.2" }],
    });
  });

  it("never sends its token to a repo on another host than the remote's", async () => {
    const { provider, ctx } = gitlab();
    const wrong: DeployContext = {
      ...ctx,
      repoOf: async () => ({ provider: "github", slug: "acme/storefront", host: "github.com" }),
    };
    await expect(provider.start(wrong, step)).rejects.toThrow(/not on GitLab/);
  });
});
