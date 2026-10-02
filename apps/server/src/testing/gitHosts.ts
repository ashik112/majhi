/**
 * A fake `fetch` for git hosts' OAuth and REST APIs, so tests never reach GitHub, GitLab or
 * Bitbucket. Routes match `METHOD url-without-query`; each request is recorded.
 */

export interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  /** The form or JSON body, parsed. */
  form: Record<string, string>;
  json: unknown;
}

export interface FakeAnswer {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}

export type FakeRoute = (req: FakeRequest) => FakeAnswer | Promise<FakeAnswer>;

export interface FakeGitHosts {
  fetch: typeof fetch;
  requests: FakeRequest[];
  /** Adds or replaces a route. */
  on(key: string, route: FakeRoute): void;
}

export function fakeGitHosts(routes: Record<string, FakeRoute> = {}): FakeGitHosts {
  const table = new Map(Object.entries(routes));
  const requests: FakeRequest[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init?.body === "string" ? init.body : "";
    let form: Record<string, string> = {};
    let json: unknown;
    if (headers["content-type"]?.includes("x-www-form-urlencoded")) {
      form = Object.fromEntries(new URLSearchParams(body));
    } else if (body !== "") {
      try {
        json = JSON.parse(body) as unknown;
      } catch {
        json = undefined;
      }
    }
    const req: FakeRequest = { method, url, headers, body, form, json };
    requests.push(req);
    const route = table.get(`${method} ${url.split("?")[0]}`);
    if (route === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const answer = await route(req);
    return new Response(answer.json === undefined ? null : JSON.stringify(answer.json), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json", ...answer.headers },
    });
  };
  return { fetch: fetchFn as typeof fetch, requests, on: (key, route) => table.set(key, route) };
}
