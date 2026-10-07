import type { DeployRunStep } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { createBitbucketProvider } from "./bitbucket.ts";
import type { DeployContext, ProviderDeps } from "./types.ts";

const COMMIT = "1".repeat(40);
const UUID = "{3f2a-0001}";

/** A Bitbucket Cloud that keeps its pipelines, and answers what the provider asks. */
function bitbucket(over: { tip?: string } = {}) {
  const calls: { method: string; path: string; body: unknown; auth: string | null }[] = [];
  const pipelines: Record<string, unknown>[] = [];
  const state = { current: { name: "PENDING" } as Record<string, unknown> };
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ method, path: `${u.pathname}${u.search}`, body, auth });
    const reply = (status: number, json: unknown) =>
      new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    const path = u.pathname.replace("/2.0/repositories/acme/storefront", "");
    if (method === "GET" && path === "/refs/branches/main")
      return reply(200, { target: { hash: over.tip ?? COMMIT } });
    if (method === "GET" && path === "/pipelines/") return reply(200, { values: pipelines });
    if (method === "POST" && path === "/pipelines/") {
      const target = (body as { target: { commit: unknown; selector: unknown } }).target;
      const made = { uuid: UUID, build_number: 41, state: { name: "PENDING" }, target };
      pipelines.unshift(made);
      return reply(201, made);
    }
    if (method === "GET" && path === `/pipelines/${encodeURIComponent(UUID)}`)
      return reply(200, { uuid: UUID, build_number: 41, state: state.current });
    return reply(404, {});
  }) as typeof fetch;
  const deps: ProviderDeps = {
    fetch: fetchFake,
    credentials: {
      git: async () => ({ token: "bb-token" }),
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
    commit: COMMIT,
    repoOf: async () => ({ provider: "bitbucket", slug: "acme/storefront", host: "bitbucket.org" }),
  };
  return { provider: createBitbucketProvider(deps), ctx, calls, pipelines, state };
}

const step: DeployRunStep = {
  kind: "bitbucket-pipeline",
  remote: "origin",
  pipeline: "deploy-prod",
  ref: "base",
  variables: { VERSION: "1.8.3" },
};

describe("the bitbucket-pipeline provider", () => {
  it("starts the custom pipeline on the commit once, with its variables, and a retry finds it started", async () => {
    const { provider, ctx, calls } = bitbucket();
    const first = await provider.start(ctx, step);
    expect(first).toEqual({ id: UUID, url: "https://bitbucket.org/acme/storefront/pipelines/results/41" });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      target: {
        type: "pipeline_ref_target",
        ref_type: "branch",
        ref_name: "main",
        commit: { type: "commit", hash: COMMIT },
        selector: { type: "custom", pattern: "deploy-prod" },
      },
      variables: [{ key: "VERSION", value: "1.8.3" }],
    });
    expect(posts[0]?.auth).toBe("Bearer bb-token");

    const again = await provider.start(ctx, step);
    expect(again.id).toBe(UUID);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("starts a new pipeline when the one of that commit ended, or is another pipeline", async () => {
    const { provider, ctx, calls, pipelines } = bitbucket();
    pipelines.push({
      uuid: "{old}",
      state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } },
      target: { commit: { hash: COMMIT }, selector: { pattern: "deploy-prod" } },
    });
    pipelines.push({
      uuid: "{other}",
      state: { name: "IN_PROGRESS" },
      target: { commit: { hash: COMMIT }, selector: { pattern: "deploy-staging" } },
    });
    await provider.start(ctx, step);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("reads running, success and every other end as failed", async () => {
    const { provider, ctx, state } = bitbucket();
    const handle = { id: UUID };
    state.current = { name: "IN_PROGRESS", stage: { name: "RUNNING" } };
    expect(await provider.poll(ctx, step, handle)).toEqual({ state: "running" });
    state.current = { name: "COMPLETED", result: { name: "SUCCESSFUL" } };
    expect(await provider.poll(ctx, step, handle)).toEqual({ state: "success" });
    state.current = { name: "COMPLETED", result: { name: "FAILED" } };
    expect(await provider.poll(ctx, step, handle)).toEqual({
      state: "failed",
      detail: "The pipeline deploy-prod failed",
    });
    state.current = { name: "COMPLETED", result: { name: "STOPPED" } };
    expect(await provider.poll(ctx, step, handle)).toMatchObject({ state: "failed" });
    state.current = { name: "IN_PROGRESS", stage: { name: "PAUSED" } };
    expect(await provider.poll(ctx, step, handle)).toMatchObject({ state: "failed" });
  });

  it("refuses a branch that is not at the commit, and a remote that is not on Bitbucket Cloud", async () => {
    const stale = bitbucket({ tip: "2".repeat(40) });
    expect(await stale.provider.preflight(stale.ctx, step)).toContain("not at 1111111");
    const ok = bitbucket();
    expect(await ok.provider.preflight(ok.ctx, step)).toBeUndefined();
    const elsewhere = bitbucket();
    const ctx = {
      ...elsewhere.ctx,
      repoOf: async () => ({ provider: "github" as const, slug: "acme/storefront", host: "github.com" }),
    };
    await expect(elsewhere.provider.start(ctx, step)).rejects.toThrow("not on Bitbucket");
  });

  it("goes back by starting the pipeline again at the earlier commit with its variables", async () => {
    const { provider, ctx, calls } = bitbucket();
    const earlier = "3".repeat(40);
    await provider.redeploy?.({ ...ctx, commit: earlier }, step, { commit: earlier, run: { id: "{old}" } });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({
      target: { commit: { hash: earlier } },
      variables: [{ key: "VERSION", value: "1.8.3" }],
    });
  });
});
