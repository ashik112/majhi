import { type ConnectionFailure, failureFromError, failureFromHttp, type TokenMethod } from "@majhi/shared";
import type { Fetch } from "./oauth.ts";

/**
 * The check of a pasted token (a `token` service): one real call to the service's own API with it.
 * The HTTP status decides, and the answer must name who the token belongs to, so a login page or a
 * proxy that answers 200 cannot pass. The token goes only to the hosts the service entry names, in a
 * header, and a redirect is never followed.
 */

export type TokenCheck =
  | { ok: true; account: string; checked: string[] }
  | { ok: false; failure: ConnectionFailure };

const TIMEOUT_MS = 15_000;

/** A string at a path of an answer. Numeric segments index arrays. */
function at(value: unknown, path: readonly string[]): string | undefined {
  let cur: unknown = value;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur === "number") return String(cur);
  return typeof cur === "string" && cur.trim() !== "" && cur.length <= 200 ? cur.trim() : undefined;
}

export async function checkToken(fetchFn: Fetch, method: TokenMethod, token: string): Promise<TokenCheck> {
  let url: URL;
  try {
    url = new URL(method.check.url);
  } catch {
    return { ok: false, failure: { reason: "unexpected" } };
  }
  // The token only ever goes to the service's own hosts.
  if (url.protocol !== "https:" || !method.hosts.includes(url.host)) {
    return { ok: false, failure: { reason: "blocked-host" } };
  }
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: method.check.method,
      headers: {
        authorization: method.auth === "raw" ? token : `Bearer ${token}`,
        accept: "application/json",
        ...(method.check.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(method.check.body === undefined ? {} : { body: method.check.body }),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, failure: { reason: failureFromError(err) } };
  }
  let reason = failureFromHttp(res.status);
  if (reason !== undefined) {
    // GraphQL services (Linear) answer a bad key with a 400 and a typed code in `errors[].extensions`.
    if (res.status === 400) {
      const body: unknown = await res.json().catch(() => undefined);
      const errors = (body as { errors?: unknown } | undefined)?.errors;
      const code = Array.isArray(errors)
        ? (errors[0] as { extensions?: { code?: unknown } } | undefined)?.extensions?.code
        : undefined;
      if (code === "AUTHENTICATION_ERROR") reason = "rejected";
    } else {
      await res.body?.cancel().catch(() => undefined);
    }
    return {
      ok: false,
      failure: {
        reason,
        status: res.status,
        ...(reason === "rejected" || reason === "forbidden"
          ? {
              fix: `${url.host} did not accept the token. Make a new one and paste it.`,
              fixUrl: method.page.url,
            }
          : {}),
      },
    };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const account = method.check.labelPaths.map((p) => at(body, p)).find((v) => v !== undefined);
  if (account === undefined) {
    return {
      ok: false,
      failure: {
        reason: "unexpected",
        status: res.status,
        fix: `${url.host} answered, but not with an account. Make a new token and paste it.`,
      },
    };
  }
  return { ok: true, account, checked: [method.check.did] };
}
