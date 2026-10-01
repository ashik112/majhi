import type { MrHost } from "@majhi/shared";
import { UserError } from "../errors.ts";
import { classifyHost } from "../scan/remote.ts";

export interface AdoptDeps {
  /** Asks the host helper for the token of one gh or glab login. */
  readToken: (via: "gh" | "glab", host: string) => Promise<string>;
  saveSecret: (input: { value: string; label: string }) => Promise<{ ref: string }>;
  /** The org's current `mr_tokens`, or undefined when the org does not exist. */
  orgTokens: (org: string) => Promise<Partial<Record<MrHost, string>> | undefined>;
  setOrgTokens: (org: string, tokens: Partial<Record<MrHost, string>>) => Promise<void>;
}

/**
 * Saves a `gh` or `glab` login's token as one org's token for the host. Only the chosen org's
 * `mr_tokens` points at it, so no other org uses it. The token is never returned or logged.
 */
export async function useGitLogin(
  deps: AdoptDeps,
  input: { id: string; via: "gh" | "glab"; host: string },
): Promise<{ id: string; host: MrHost; ref: string }> {
  const current = await deps.orgTokens(input.id);
  if (current === undefined) throw new UserError(`Org "${input.id}" does not exist.`, 404);
  const classified = classifyHost(input.host);
  const host: MrHost = classified === "other" ? (input.via === "gh" ? "github" : "gitlab") : classified;
  if ((input.via === "gh") !== (host === "github")) {
    throw new UserError(`${input.via} cannot be used for ${input.host}.`);
  }
  const token = await deps.readToken(input.via, input.host.toLowerCase());
  const { ref } = await deps.saveSecret({ value: token, label: `${input.id} ${host} token` });
  await deps.setOrgTokens(input.id, { ...current, [host]: ref });
  return { id: input.id, host, ref };
}
