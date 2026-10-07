import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * A fake GitHub, GitLab and Vercel on one loopback port, for deploy tests and proofs. It answers the calls
 * the deploy providers make, keeps what was called, and ends each run the way the test set it. Nothing here
 * reaches a real service.
 */

export interface FakeCall {
  method: string;
  path: string;
  /** The bearer token the call carried, so a test can check which credential went where. */
  token: string | undefined;
  body: unknown;
}

export interface FakeHosts {
  port: number;
  /** `127.0.0.1:<port>`: the `host` of a git connection that points here. */
  host: string;
  /** `http://127.0.0.1:<port>`: Vercel's API address. */
  url: string;
  tokens: { github: string; gitlab: string; vercel: string };
  /** Branch tips by `<provider>:<slug>:<branch>`. */
  branches: Map<string, string>;
  /** How the next runs end. */
  outcome: { github: "success" | "failure"; gitlab: "success" | "failed"; vercel: "READY" | "ERROR" };
  /** Looks at a run before it reads as finished. */
  pollsToFinish: number;
  /** What `GET /health/<name>` answers, by name. Absent: 200. */
  health: Map<string, number>;
  calls: FakeCall[];
  close(): Promise<void>;
}

interface Run {
  id: number;
  sha: string;
  slug: string;
  polls: number;
  attempt: number;
  provider: "github" | "gitlab" | "vercel";
  finished: boolean;
  /** How this run ends, fixed when it was made: a run made to succeed succeeds again when it is run again. */
  result: string;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (c: Buffer) => {
      text += c.toString();
    });
    req.on("end", () => {
      try {
        resolve(text === "" ? undefined : (JSON.parse(text) as unknown));
      } catch {
        resolve(undefined);
      }
    });
  });
}

export async function startFakeHosts(
  init: { tokens?: Partial<FakeHosts["tokens"]>; pollsToFinish?: number; port?: number } = {},
): Promise<FakeHosts> {
  const tokens = {
    github: init.tokens?.github ?? "gh-fake-token-1111",
    gitlab: init.tokens?.gitlab ?? "gl-fake-token-2222",
    vercel: init.tokens?.vercel ?? "vc-fake-token-3333",
  };
  const runs = new Map<number, Run>();
  let nextRun = 100;
  const state: FakeHosts = {
    port: 0,
    host: "",
    url: "",
    tokens,
    branches: new Map(),
    outcome: { github: "success", gitlab: "success", vercel: "READY" },
    pollsToFinish: init.pollsToFinish ?? 1,
    health: new Map(),
    calls: [],
    close: async () => undefined,
  };

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };

  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const body = await readBody(req);
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    state.calls.push({ method, path: `${path}${url.search}`, token, body });
    const need = (provider: keyof typeof tokens): boolean => {
      if (token === tokens[provider]) return true;
      send(res, 401, { message: "Bad credentials" });
      return false;
    };
    const finished = (run: Run): boolean => {
      run.polls += 1;
      return run.polls > state.pollsToFinish;
    };

    const probe = /^\/health\/([^/]+)$/.exec(path);
    if (probe !== null) {
      const status = state.health.get(decodeURIComponent(probe[1] ?? "")) ?? 200;
      res.writeHead(status, { "content-type": "text/plain" });
      return void res.end(status < 300 ? "ok" : "down");
    }

    // GitHub: /api/v3/repos/<owner>/<repo>/...
    const gh = /^\/api\/v3\/repos\/([^/]+\/[^/]+)\/(.*)$/.exec(path);
    if (gh !== null) {
      if (!need("github")) return;
      const slug = gh[1] ?? "";
      const rest = gh[2] ?? "";
      const branch = /^branches\/(.+)$/.exec(rest);
      if (method === "GET" && branch !== null) {
        const sha = state.branches.get(`github:${slug}:${decodeURIComponent(branch[1] ?? "")}`);
        return sha === undefined
          ? send(res, 404, { message: "Branch not found" })
          : send(res, 200, { commit: { sha } });
      }
      const dispatch = /^actions\/workflows\/([^/]+)\/dispatches$/.exec(rest);
      if (method === "POST" && dispatch !== null) {
        const ref = (body as { ref?: string } | undefined)?.ref ?? "";
        const sha = state.branches.get(`github:${slug}:${ref}`);
        if (sha === undefined) return send(res, 422, { message: "No ref found" });
        const run: Run = {
          id: nextRun++,
          sha,
          slug,
          polls: 0,
          attempt: 1,
          provider: "github",
          finished: false,
          result: state.outcome.github,
        };
        runs.set(run.id, run);
        return send(res, 204);
      }
      const list = /^actions\/workflows\/([^/]+)\/runs$/.exec(rest);
      if (method === "GET" && list !== null) {
        const mine = [...runs.values()].filter((r) => r.provider === "github" && r.slug === slug);
        return send(res, 200, {
          workflow_runs: mine.map((r) => ({
            id: r.id,
            head_sha: r.sha,
            created_at: new Date().toISOString(),
            html_url: `http://${state.host}/${slug}/actions/runs/${r.id}`,
          })),
        });
      }
      const one = /^actions\/runs\/(\d+)(?:\/(rerun|jobs))?$/.exec(rest);
      if (one !== null) {
        const run = runs.get(Number(one[1]));
        if (run === undefined) return send(res, 404, { message: "Not found" });
        if (method === "POST" && one[2] === "rerun") {
          run.attempt += 1;
          run.polls = 0;
          return send(res, 201);
        }
        if (method === "GET" && one[2] === "jobs") {
          return send(res, 200, {
            jobs: [
              {
                name: "deploy",
                conclusion: "failure",
                steps: [{ name: "Upload build", conclusion: "failure" }],
              },
            ],
          });
        }
        if (method === "GET") {
          const done = finished(run);
          return send(res, 200, {
            id: run.id,
            run_attempt: run.attempt,
            status: done ? "completed" : "in_progress",
            conclusion: done ? run.result : null,
            html_url: `http://${state.host}/${run.slug}/actions/runs/${run.id}`,
          });
        }
      }
      return send(res, 404, { message: "Not found" });
    }

    // GitLab: /api/v4/projects/<encoded slug>/...
    const gl = /^\/api\/v4\/projects\/([^/]+)\/(.*)$/.exec(path);
    if (gl !== null) {
      if (!need("gitlab")) return;
      const slug = decodeURIComponent(gl[1] ?? "");
      const rest = gl[2] ?? "";
      const branch = /^repository\/branches\/(.+)$/.exec(rest);
      if (method === "GET" && branch !== null) {
        const sha = state.branches.get(`gitlab:${slug}:${decodeURIComponent(branch[1] ?? "")}`);
        return sha === undefined
          ? send(res, 404, { message: "404 Branch Not Found" })
          : send(res, 200, { commit: { id: sha } });
      }
      if (method === "POST" && rest === "repository/branches") {
        const made = body as { branch?: string; ref?: string } | undefined;
        if (made?.branch === undefined || made.ref === undefined) return send(res, 400, { message: "bad" });
        state.branches.set(`gitlab:${slug}:${made.branch}`, made.ref);
        return send(res, 201, { name: made.branch });
      }
      if (method === "POST" && rest === "pipeline") {
        const ref = (body as { ref?: string } | undefined)?.ref ?? "";
        const sha = state.branches.get(`gitlab:${slug}:${ref}`);
        if (sha === undefined) return send(res, 400, { message: "Reference not found" });
        const run: Run = {
          id: nextRun++,
          sha,
          slug,
          polls: 0,
          attempt: 1,
          provider: "gitlab",
          finished: false,
          result: state.outcome.gitlab,
        };
        runs.set(run.id, run);
        return send(res, 201, {
          id: run.id,
          status: "pending",
          web_url: `http://${state.host}/${slug}/-/pipelines/${run.id}`,
        });
      }
      const pipe = /^pipelines\/(\d+)$/.exec(rest);
      if (method === "GET" && pipe !== null) {
        const run = runs.get(Number(pipe[1]));
        if (run === undefined) return send(res, 404, { message: "Not found" });
        const done = finished(run);
        return send(res, 200, { id: run.id, status: done ? run.result : "running" });
      }
      return send(res, 404, { message: "Not found" });
    }

    // Vercel: /v13/deployments
    if (path === "/v13/deployments" && method === "POST") {
      if (!need("vercel")) return;
      const spec = body as { gitSource?: { sha?: string; ref?: string }; deploymentId?: string } | undefined;
      const sha =
        spec?.deploymentId !== undefined
          ? (runs.get(Number(spec.deploymentId))?.sha ?? "")
          : (spec?.gitSource?.sha ?? "");
      const run: Run = {
        id: nextRun++,
        sha,
        slug: "",
        polls: 0,
        attempt: 1,
        provider: "vercel",
        finished: false,
        result:
          spec?.deploymentId !== undefined
            ? (runs.get(Number(spec.deploymentId))?.result ?? state.outcome.vercel)
            : state.outcome.vercel,
      };
      runs.set(run.id, run);
      return send(res, 200, {
        id: String(run.id),
        url: `storefront-${run.id}.vercel.test`,
        readyState: "QUEUED",
      });
    }
    const dep = /^\/v13\/deployments\/(\d+)$/.exec(path);
    if (dep !== null && method === "GET") {
      if (!need("vercel")) return;
      const run = runs.get(Number(dep[1]));
      if (run === undefined) return send(res, 404, { error: { code: "not_found" } });
      const done = finished(run);
      return send(res, 200, {
        id: String(run.id),
        readyState: done ? run.result : "BUILDING",
        ...(done && run.result === "ERROR" ? { errorMessage: "Build failed" } : {}),
      });
    }
    send(res, 404, { message: "Not found" });
  };

  const server: Server = createServer((req, res) => {
    void serve(req, res).catch(() => send(res, 500, { message: "fake failed" }));
  });
  await new Promise<void>((resolve) => server.listen(init.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  state.port = typeof address === "object" && address !== null ? address.port : 0;
  state.host = `127.0.0.1:${state.port}`;
  state.url = `http://${state.host}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}
