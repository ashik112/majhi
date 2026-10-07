import { describe, expect, it } from "vitest";
import { BitbucketHost } from "./bitbucket.ts";
import type { Exec } from "./exec.ts";
import { GitHubHost } from "./github.ts";
import { GitLabHost } from "./gitlab.ts";
import type { MrTarget } from "./types.ts";

/** Approval state parsed from each host's own answers, and the conditional requests that save polls. */

const gh: MrTarget = { host: "github", slug: "acme/api" };
const gl: MrTarget = { host: "gitlab", slug: "acme/platform/web" };
const bb: MrTarget = { host: "bitbucket", slug: "acme/api", token: "me@acme.test:token" };

const http = (status: number, etag: string | undefined, body: unknown): string =>
  `HTTP/2.0 ${status} X\r\n${etag === undefined ? "" : `Etag: ${etag}\r\n`}Content-Type: application/json\r\n\r\n${
    body === undefined ? "" : JSON.stringify(body)
  }`;

describe("GitHub reviews", () => {
  const prView = JSON.stringify({
    state: "OPEN",
    url: "https://github.com/acme/api/pull/7",
    statusCheckRollup: [],
  });
  const reviews = [
    { user: { login: "ana" }, state: "CHANGES_REQUESTED" },
    { user: { login: "bo" }, state: "COMMENTED" },
    { user: { login: "ana" }, state: "APPROVED" },
    { user: { login: "cy" }, state: "APPROVED" },
    { user: { login: "cy" }, state: "DISMISSED" },
  ];
  const pr = { requested_reviewers: [{ login: "bo" }], requested_teams: [{ slug: "core" }] };

  it("takes the latest approval or change request per reviewer and the asked reviewers", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (_bin, args) => {
      calls.push([...args]);
      if (args[0] === "pr") return { code: 0, stdout: prView, stderr: "" };
      const path = args.at(-1) ?? "";
      return { code: 0, stdout: http(200, '"x"', path.includes("/reviews") ? reviews : pr), stderr: "" };
    };
    const status = await new GitHubHost(exec).status(gh, 7);
    expect(status.review).toEqual({
      approved: true,
      approvals: 1,
      changesRequested: false,
      pending: ["bo", "core"],
    });
  });

  it("an unresolved change request blocks approval", async () => {
    const exec: Exec = async (_bin, args) =>
      args[0] === "pr"
        ? { code: 0, stdout: prView, stderr: "" }
        : {
            code: 0,
            stdout: http(
              200,
              undefined,
              (args.at(-1) ?? "").includes("/reviews")
                ? [
                    { user: { login: "ana" }, state: "APPROVED" },
                    { user: { login: "bo" }, state: "CHANGES_REQUESTED" },
                  ]
                : {},
            ),
            stderr: "",
          };
    const status = await new GitHubHost(exec).status(gh, 7);
    expect(status.review).toMatchObject({ approved: false, approvals: 1, changesRequested: true });
  });

  it("asks again with the ETag and reuses the answer on a 304", async () => {
    const seen: string[][] = [];
    const exec: Exec = async (_bin, args) => {
      if (args[0] === "pr") return { code: 0, stdout: prView, stderr: "" };
      seen.push([...args]);
      const tag = args.find((a) => a.startsWith("If-None-Match:"));
      if (tag !== undefined) return { code: 1, stdout: http(304, '"x"', undefined), stderr: "HTTP 304" };
      const path = args.at(-1) ?? "";
      return { code: 0, stdout: http(200, '"x"', path.includes("/reviews") ? reviews : pr), stderr: "" };
    };
    const host = new GitHubHost(exec);
    const first = await host.status(gh, 7);
    const second = await host.status(gh, 7);
    expect(second.review).toEqual(first.review);
    expect(seen.filter((a) => a.includes('If-None-Match: "x"'))).toHaveLength(2);
  });

  it("a failed review read keeps the state and CI", async () => {
    const exec: Exec = async (_bin, args) =>
      args[0] === "pr" ? { code: 0, stdout: prView, stderr: "" } : { code: 1, stdout: "", stderr: "boom" };
    const status = await new GitHubHost(exec).status(gh, 7);
    expect(status).toMatchObject({ state: "open", ci: "none" });
    expect(status.review).toBeUndefined();
  });
});

describe("GitLab approvals", () => {
  const view = JSON.stringify({
    state: "opened",
    web_url: "https://gitlab.com/acme/platform/web/-/merge_requests/3",
    head_pipeline: null,
    reviewers: [{ username: "ana" }, { username: "bo" }],
    blocking_discussions_resolved: false,
  });
  const approvals = {
    approved: false,
    approvals_left: 1,
    approved_by: [{ user: { username: "ana" } }],
  };

  it("reads approvals left, who approved, pending reviewers and unresolved discussions", async () => {
    const exec: Exec = async (_bin, args) =>
      args[0] === "mr"
        ? { code: 0, stdout: view, stderr: "" }
        : { code: 0, stdout: http(200, 'W/"a"', approvals), stderr: "" };
    const status = await new GitLabHost(exec).status(gl, 3);
    expect(status.review).toEqual({
      approved: false,
      approvals: 1,
      approvalsNeeded: 1,
      changesRequested: true,
      pending: ["bo"],
    });
  });
});

describe("Bitbucket participants", () => {
  function fake(participants: unknown[]) {
    const seen: { path: string; match: string | null }[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input).replace("https://api.bitbucket.org/2.0", "");
      const match = new Headers(init?.headers).get("if-none-match");
      seen.push({ path, match });
      if (path.endsWith("/statuses")) return new Response(JSON.stringify({ values: [] }), { status: 200 });
      if (match === '"p1"') return new Response(null, { status: 304 });
      return new Response(
        JSON.stringify({
          state: "OPEN",
          links: { html: { href: "https://bitbucket.org/acme/api/pull-requests/5" } },
          participants,
        }),
        { status: 200, headers: { etag: '"p1"' } },
      );
    }) as typeof fetch;
    return { host: new BitbucketHost({ fetch: fetcher }), seen };
  }

  it("counts approvals and change requests, and lists silent reviewers", async () => {
    const { host } = fake([
      { role: "REVIEWER", approved: true, state: "approved", user: { display_name: "Ana" } },
      { role: "REVIEWER", approved: false, state: null, user: { display_name: "Bo" } },
      { role: "PARTICIPANT", approved: false, state: null, user: { display_name: "Cy" } },
    ]);
    const status = await host.status(bb, 5);
    expect(status.review).toEqual({ approved: true, approvals: 1, changesRequested: false, pending: ["Bo"] });
  });

  it("changes requested wins over an approval, and a 304 reuses the stored answer", async () => {
    const { host, seen } = fake([
      { role: "REVIEWER", approved: true, state: "approved", user: { display_name: "Ana" } },
      { role: "REVIEWER", approved: false, state: "changes_requested", user: { display_name: "Bo" } },
    ]);
    const first = await host.status(bb, 5);
    const second = await host.status(bb, 5);
    expect(first.review).toMatchObject({
      approved: false,
      approvals: 1,
      changesRequested: true,
      pending: [],
    });
    expect(second.review).toEqual(first.review);
    expect(seen.filter((s) => s.match === '"p1"')).toHaveLength(1);
  });
});
