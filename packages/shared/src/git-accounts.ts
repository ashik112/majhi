import { z } from "zod";
import { MrHostSchema } from "./accounts.ts";
import { GitHostSchema } from "./api.ts";

/** How an org's account pushes: an SSH key, this computer's saved https login, or nothing found yet. */
export const PushStatusSchema = z.discriminatedUnion("state", [
  /** An SSH key logs in as the account. No alias: the host's default key. */
  z.object({ state: z.literal("ssh"), alias: z.string().optional() }),
  /** No SSH key fits; https pushes from this computer with the login its credential helper saved. */
  z.object({ state: z.literal("https") }),
  /** The host helper is not connected, so this computer's keys and logins are not known. */
  z.object({ state: z.literal("unknown") }),
  z.object({
    state: z.literal("missing"),
    /** Detected SSH routes that log in as this account. `ssh` is `default` or an alias. */
    choices: z.array(z.object({ ssh: z.string(), label: z.string() })),
    /** Why no key was found, when a key was accepted but could not be tied to this account. */
    note: z.string().optional(),
  }),
]);
export type PushStatus = z.infer<typeof PushStatusSchema>;

/** Whether the account has a token for merge requests, checked with one call to the host's API. */
export const TokenStatusSchema = z.discriminatedUnion("state", [
  /** The host answered for this account. */
  z.object({ state: z.literal("ok"), as: z.string() }),
  /** A token is saved, but the host was not reached, so it was not checked. */
  z.object({ state: z.literal("unchecked") }),
  /** A token is saved and the host refused it. */
  z.object({ state: z.literal("refused") }),
  z.object({
    state: z.literal("missing"),
    /** A `gh` or `glab` login for this host and account. */
    cli: z.enum(["gh", "glab"]).optional(),
    /** This computer saved a login for the account that the host's API accepts as a token. */
    savedLogin: z.boolean(),
  }),
]);
export type TokenStatus = z.infer<typeof TokenStatusSchema>;

export const GitAccountStatusSchema = z.object({
  host: z.string(),
  account: z.string(),
  kind: GitHostSchema,
  push: PushStatusSchema,
  token: TokenStatusSchema,
});
export type GitAccountStatus = z.infer<typeof GitAccountStatusSchema>;

/** A login found on this computer for a host the org uses, offered as its account there. */
export const LoginOfferSchema = z.object({
  account: z.string(),
  /** `default` or an alias when an SSH key logs in as it. */
  ssh: z.string().optional(),
  /** How it was found: `ssh`, `gh`, `glab`. */
  via: z.array(z.enum(["ssh", "gh", "glab"])).min(1),
});
export type LoginOffer = z.infer<typeof LoginOfferSchema>;

/** `orgs.gitStatus`: one row per host. Never holds a token. */
export const GitStatusSchema = z.object({
  /** When this computer's logins were last detected. Absent when the host helper is not connected. */
  checkedAt: z.string().optional(),
  accounts: z.array(GitAccountStatusSchema),
  /** Hosts the org's projects use that have no account yet, with the logins found for each. */
  missing: z.array(z.object({ host: z.string(), kind: GitHostSchema, offers: z.array(LoginOfferSchema) })),
  /** MR tokens saved for a host kind that no account of the org covers. */
  tokens: z.array(z.object({ kind: MrHostSchema, ref: z.string() })),
});
export type GitStatus = z.infer<typeof GitStatusSchema>;

/**
 * The host page that makes a token, prefilled where the host allows it. Undefined for hosts majhi
 * does not know.
 */
export function tokenPageUrl(
  kind: z.infer<typeof GitHostSchema>,
  host: string,
  org: string,
): string | undefined {
  const name = encodeURIComponent(`majhi-${org}`);
  if (kind === "github")
    return `https://github.com/settings/tokens/new?description=${name}&scopes=repo,read:org,workflow`;
  if (kind === "gitlab")
    return `https://${host}/-/user_settings/personal_access_tokens?name=${name}&scopes=api,read_user,write_repository`;
  if (kind === "bitbucket") return "https://id.atlassian.com/manage-profile/security/api-tokens";
  return undefined;
}
