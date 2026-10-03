import type { OrgConfig } from "@majhi/shared";
import type { GitTokens } from "../gitConnect/tokens.ts";
import { pushAuthFor } from "../gitConnect/wire.ts";
import { mrKindOf } from "../orgs/gitAccount.ts";
import { classifyHost } from "../scan/remote.ts";

/** The host a source is fetched from: the URL's, or GitHub for `owner/repo` shorthand. */
export function sourceHost(source: string): string | undefined {
  try {
    const url = new URL(source);
    return url.protocol === "https:" ? url.hostname.toLowerCase() : undefined;
  } catch {
    return /^[\w.-]+\/[\w.-]+/.test(source) && !source.startsWith(".") ? "github.com" : undefined;
  }
}

/**
 * Git settings for fetching a private repo with the org's own login: an `Authorization` header for
 * that one host, in the environment of the throwaway run, so the token is in no argument, file or
 * log. Empty when the source is not https, no org is given, or the org has no token for the host.
 */
export async function skillGitEnv(
  tokens: GitTokens,
  orgs: Record<string, OrgConfig>,
  org: string | undefined,
  source: string,
): Promise<Record<string, string>> {
  const host = sourceHost(source);
  if (org === undefined || host === undefined) return {};
  const auth = await pushAuthFor(tokens, orgs, org, `https://${host}/x/y`, (h) => mrKindOf(classifyHost(h)));
  if (auth === undefined || auth.kind !== "token") return {};
  const basic = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.https://${host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}
