import type { CiState, MrState } from "@majhi/shared";
import { type MrHostClient, MrHostError, type MrStatus, type MrTarget, scrub } from "./types.ts";

export const BITBUCKET_API = "https://api.bitbucket.org/2.0";
const REQUEST_TIMEOUT_MS = 30_000;

export interface BitbucketOptions {
  /** Replaces the network, so tests never reach Bitbucket. */
  fetch?: typeof fetch;
  api?: string;
}

/**
 * Bitbucket Cloud through its REST API. The token is `email:api-token` (an Atlassian API token, basic auth), or a
 * workspace or repository access token (bearer), whichever the owner saved.
 */
export class BitbucketHost implements MrHostClient {
  private readonly fetch: typeof fetch;
  private readonly api: string;

  constructor(options: BitbucketOptions = {}) {
    this.fetch = options.fetch ?? fetch;
    this.api = (options.api ?? BITBUCKET_API).replace(/\/+$/, "");
  }

  async open(t: MrTarget, mr: { head: string; base: string; title: string; body: string }) {
    const data = await this.call(t, "POST", `/repositories/${t.slug}/pullrequests`, {
      title: mr.title,
      description: mr.body,
      source: { branch: { name: mr.head } },
      destination: { branch: { name: mr.base } },
    });
    const number = Number(data.id);
    const url = (data.links as { html?: { href?: string } } | undefined)?.html?.href;
    if (!Number.isInteger(number) || typeof url !== "string") {
      throw new MrHostError("Bitbucket created a pull request but did not say which.");
    }
    return { url, number };
  }

  async updateDescription(t: MrTarget, number: number, mr: { title: string; body: string }) {
    await this.call(t, "PUT", `/repositories/${t.slug}/pullrequests/${number}`, {
      title: mr.title,
      description: mr.body,
    });
  }

  async status(t: MrTarget, number: number): Promise<MrStatus> {
    const path = `/repositories/${t.slug}/pullrequests/${number}`;
    const pr = await this.call(t, "GET", path);
    const state = stateOf(String(pr.state ?? ""));
    const url = (pr.links as { html?: { href?: string } } | undefined)?.html?.href ?? "";
    // Checks only matter while the MR is open, so a merged one costs one request.
    if (state !== "open") return { state, ci: "none", url };
    const statuses = await this.call(t, "GET", `${path}/statuses`);
    return { state, ci: ciOf(statuses.values), url };
  }

  async merge(t: MrTarget, number: number) {
    await this.call(t, "POST", `/repositories/${t.slug}/pullrequests/${number}/merge`, {
      type: "pullrequest",
      merge_strategy: "merge_commit",
    });
  }

  private async call(
    t: MrTarget,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    if (t.token === undefined) {
      throw new MrHostError(
        "No Bitbucket credentials are set for this project. Save a token and add it to the org's mr_tokens or the remote's token.",
      );
    }
    const auth = t.token.includes(":")
      ? `Basic ${Buffer.from(t.token).toString("base64")}`
      : `Bearer ${t.token}`;
    let res: Response;
    try {
      res = await this.fetch(`${this.api}${path}`, {
        method,
        headers: {
          authorization: auth,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new MrHostError(
        scrub(`Could not reach Bitbucket: ${err instanceof Error ? err.message : String(err)}`, t.token),
      );
    }
    const text = await res.text();
    if (!res.ok) {
      throw new MrHostError(scrub(`Bitbucket answered ${res.status}: ${errorText(text)}`, t.token));
    }
    if (text === "") return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new MrHostError("Bitbucket answered with something that is not JSON.");
    }
  }
}

function errorText(text: string): string {
  try {
    const message = (JSON.parse(text) as { error?: { message?: string } }).error?.message;
    if (typeof message === "string") return message.slice(0, 300);
  } catch {
    // Not JSON: fall through to the raw start.
  }
  return text.trim().slice(0, 300);
}

function stateOf(state: string): MrState {
  if (state === "MERGED") return "merged";
  if (state === "DECLINED" || state === "SUPERSEDED") return "closed";
  return "open";
}

/** Build statuses of a pull request as one CI state. */
export function ciOf(values: unknown): CiState {
  if (!Array.isArray(values) || values.length === 0) return "none";
  let pending = false;
  for (const item of values as { state?: string }[]) {
    if (item.state === "FAILED" || item.state === "STOPPED") return "failing";
    if (item.state !== "SUCCESSFUL") pending = true;
  }
  return pending ? "pending" : "passing";
}
