import {
  type ConnectionFailure,
  failureFromError,
  failureFromHttp,
  gitTokenHelp,
  type MrHost,
} from "@majhi/shared";
import type { Fetch } from "./http.ts";
import { str } from "./http.ts";
import { bitbucketAuth } from "./oauth.ts";

/**
 * The check behind a git host connection: a real call to the host's own API with the stored token.
 * Two calls, so "connected" means more than "the token parses": who the token belongs to, then a list
 * of one repository (or project). The HTTP status of each call decides; the words of an answer never
 * do. A redirect is never followed, since a token must go only to the host the owner named.
 */

export type GitCheck =
  | { ok: true; account: string; checked: string[] }
  | { ok: false; failure: ConnectionFailure };

const TIMEOUT_MS = 15_000;

interface Step {
  /** What a pass of this step says, as a sentence in the past tense. */
  did: string;
  url: string;
  headers: Record<string, string>;
  /** The account, read from the answer. Only the first step gives one. */
  account?: (reply: { body: unknown; headers: Headers }) => string | undefined;
}

/** The API calls for one host kind. Bitbucket Cloud and Server, GitHub.com and Enterprise differ. */
export function gitSteps(kind: MrHost, host: string, token: string): Step[] {
  if (kind === "github") {
    const base = host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
    const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" };
    return [
      {
        did: `Asked ${host} who the token belongs to`,
        url: `${base}/user`,
        headers,
        account: (r) => str(r.body, "login"),
      },
      { did: "Listed one repository", url: `${base}/user/repos?per_page=1`, headers },
    ];
  }
  if (kind === "gitlab") {
    const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
    return [
      {
        did: `Asked ${host} who the token belongs to`,
        url: `https://${host}/api/v4/user`,
        headers,
        account: (r) => str(r.body, "username"),
      },
      {
        did: "Listed one project",
        url: `https://${host}/api/v4/projects?membership=true&per_page=1&simple=true`,
        headers,
      },
    ];
  }
  if (host === "bitbucket.org") {
    const headers = { authorization: bitbucketAuth(token), accept: "application/json" };
    return [
      {
        did: "Asked Bitbucket who the token belongs to",
        url: "https://api.bitbucket.org/2.0/user",
        headers,
        account: (r) => str(r.body, "nickname") ?? str(r.body, "display_name") ?? str(r.body, "username"),
      },
      {
        // The cross-workspace /2.0/repositories list is gone (CHANGE-2770); workspaces is what stays.
        did: "Listed one workspace",
        url: "https://api.bitbucket.org/2.0/user/workspaces?pagelen=1",
        headers,
      },
    ];
  }
  // Bitbucket Server and Data Center take an HTTP access token as a Bearer, and name the user in a header.
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  return [
    {
      did: `Asked ${host} who the token belongs to`,
      url: `https://${host}/plugins/servlet/applinks/whoami`,
      headers,
      account: (r) => {
        const name = r.headers.get("x-ausername");
        return name === null || name === "" ? undefined : decodeURIComponent(name);
      },
    },
    { did: "Listed one repository", url: `https://${host}/rest/api/1.0/repos?limit=1`, headers },
  ];
}

/** Where the owner makes a new token on this host, for a failure to point at. */
function fixPage(kind: MrHost, host: string): string | undefined {
  try {
    return gitTokenHelp(kind, host, "majhi", "chosen").link.url;
  } catch {
    return undefined;
  }
}

export async function checkGitToken(
  fetchFn: Fetch,
  kind: MrHost,
  host: string,
  token: string,
): Promise<GitCheck> {
  const checked: string[] = [];
  let account: string | undefined;
  for (const step of gitSteps(kind, host, token)) {
    let res: Response;
    try {
      res = await fetchFn(step.url, {
        headers: step.headers,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, failure: { reason: failureFromError(err) } };
    }
    const text = await res.text().catch(() => "");
    const reason = failureFromHttp(res.status);
    if (reason !== undefined) {
      const page = reason === "rejected" || reason === "forbidden" ? fixPage(kind, host) : undefined;
      return {
        ok: false,
        failure: {
          reason,
          status: res.status,
          ...(reason === "rejected"
            ? { fix: `${host} refused the token. Make a new token and paste it.` }
            : reason === "forbidden"
              ? {
                  fix: `${host} accepts the token but not this call. Give it access to repositories, or make a new token.`,
                }
              : reason === "not-found"
                ? {
                    fix: `${host} does not answer as ${kind === "github" ? "GitHub" : kind === "gitlab" ? "GitLab" : "Bitbucket"}. Check the host you entered.`,
                  }
                : {}),
          ...(page === undefined ? {} : { fixUrl: page }),
        },
      };
    }
    if (step.account !== undefined) {
      let body: unknown;
      try {
        body = text === "" ? undefined : (JSON.parse(text) as unknown);
      } catch {
        body = undefined;
      }
      account = step.account({ body, headers: res.headers });
      if (account === undefined) {
        // A 200 that does not name who it is for is not the host's API (a login page, a proxy).
        // Bitbucket Server answers an unknown token with 200 and no user: that is a refusal.
        return {
          ok: false,
          failure:
            kind === "bitbucket" && host !== "bitbucket.org"
              ? {
                  reason: "rejected",
                  status: res.status,
                  fix: `${host} did not recognize the token. Make a new access token and paste it.`,
                }
              : {
                  reason: "unexpected",
                  status: res.status,
                  fix: `${host} answered, but not like its API. Check the host you entered.`,
                },
        };
      }
    }
    checked.push(step.did);
  }
  return { ok: true, account: account ?? "", checked };
}
