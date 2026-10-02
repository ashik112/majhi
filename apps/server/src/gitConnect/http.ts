/**
 * One HTTP call to a git host's OAuth or REST API. Tokens go in headers or form bodies only, never in
 * a URL, and no error message here ever holds a header, a body or a token: callers get the status
 * and the parsed JSON, and decide on a plain sentence themselves.
 */

export type Fetch = typeof fetch;

const REQUEST_TIMEOUT_MS = 15_000;

export interface HttpAnswer {
  status: number;
  /** Parsed JSON, or undefined when the body was empty or not JSON. */
  body: unknown;
  headers: Headers;
}

/** The host could not be reached, or answered something that is not a known shape. Safe to show. */
export class HostUnreachable extends Error {}

/** The host answered 401 or 403 to a token. Safe to show. */
export class TokenRefused extends Error {}

export interface HttpRequest {
  method?: "GET" | "POST" | "DELETE" | "PUT";
  headers?: Record<string, string>;
  /** Sent as `application/x-www-form-urlencoded`. */
  form?: Record<string, string>;
  /** Sent as JSON. */
  json?: unknown;
}

/** Calls `url` and never throws anything but `HostUnreachable`. Redirects are refused. */
export async function call(fetchFn: Fetch, url: string, req: HttpRequest = {}): Promise<HttpAnswer> {
  const headers: Record<string, string> = { accept: "application/json", ...req.headers };
  let body: string | undefined;
  if (req.form !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(req.form).toString();
  } else if (req.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(req.json);
  }
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: req.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new HostUnreachable(`majhi could not reach ${hostOf(url)}. Check the connection and try again.`);
  }
  const text = await res.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : (JSON.parse(text) as unknown);
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

/** Like `call`, for an API call made with a token: 401 and 403 throw `TokenRefused`, other errors `HostUnreachable`. */
export async function callWithToken(fetchFn: Fetch, url: string, req: HttpRequest): Promise<HttpAnswer> {
  const answer = await call(fetchFn, url, req);
  if (answer.status === 401 || answer.status === 403) {
    throw new TokenRefused(`${hostOf(url)} refused the workspace's token.`);
  }
  if (answer.status < 200 || answer.status >= 300) {
    throw new HostUnreachable(`${hostOf(url)} answered ${answer.status}. Try again in a moment.`);
  }
  return answer;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the git host";
  }
}

/** A field of a JSON object, when it is a non-empty string. */
export function str(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A field of a JSON object, when it is a finite number. */
export function num(body: unknown, key: string): number | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
