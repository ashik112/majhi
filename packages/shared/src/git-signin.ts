import { z } from "zod";
import { IdSchema, MrHostSchema } from "./accounts.ts";

/**
 * Git sign-in per workspace (org in code). The owner signs a workspace in to GitHub, GitLab or
 * Bitbucket; majhi saves the token for that workspace only, in `secrets.age`, and points the
 * workspace's git account and `mr_tokens` at it, so Ship, MRs and push use it.
 *
 * - GitHub: the GitHub CLI's own browser login (`gh auth login --web`), run by the host helper with
 *   a config folder of the workspace's own. Without `gh`: a token pasted from a prefilled page.
 *   A device flow with majhi's own client ID is the second path, only once `BUILT_IN_OAUTH_APPS`
 *   (or `git_apps.github`) has one.
 * - GitLab: the GitLab CLI's browser login (`glab auth login --web`) for gitlab.com, the same way.
 *   Without `glab`, or on a self-hosted GitLab: a pasted personal access token. Tokens from glab
 *   last about 2 hours; majhi refreshes them with glab's public client ID.
 * - Bitbucket: an Atlassian API token with scopes, pasted with the Atlassian account email. No
 *   admin access is needed.
 *
 * See docs/briefs/onboarding-and-git-connect.md for the flows and the security rules.
 */

/** The public host each kind signs in to when the call names none. */
export const DEFAULT_GIT_HOST = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
} as const satisfies Record<z.infer<typeof MrHostSchema>, string>;

/**
 * Public client IDs of OAuth apps the majhi project registers, used when majhi.yaml `git_apps`
 * names none. Device flow needs no client secret, so these are safe to ship. Empty until such apps
 * exist: sign-in then goes through the host's CLI or a pasted token. `git.oauthApps.set` overrides
 * them per install.
 */
export const BUILT_IN_OAUTH_APPS: { github: string; gitlab: Readonly<Record<string, string>> } = {
  github: "",
  gitlab: { "gitlab.com": "" },
};

/** The oldest GitLab that offers the device authorization grant by default (17.3; GA in 17.9). */
export const GITLAB_DEVICE_GRANT_MIN_VERSION = "17.3";

/** A git host name as typed or found in a remote, like `gitlab.com` or `gitlab.acme.test:8443`. */
export const GitHostNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/, "Use a host name like gitlab.com");

/**
 * The public client ID of the GitLab CLI's own OAuth app on gitlab.com (`DefaultClientID` in
 * glab's `internal/glinstance/host.go`). A token from `glab auth login --web` is refreshed with it.
 */
export const GLAB_CLIENT_ID = "41d48f9422ebd655dd9cf2947d6979681dfaddc6d0c56f7628f6ada59559af1e";

/** The scopes a pasted GitHub token needs, and the ones `gh` asks for. */
export const GITHUB_TOKEN_SCOPES = ["repo", "read:org", "workflow"] as const;
/** The scopes a pasted GitLab personal access token needs. */
export const GITLAB_TOKEN_SCOPES = ["api", "read_user", "write_repository"] as const;
/** The scopes of a Bitbucket API token. `admin:repository:bitbucket` only to let majhi make repos. */
export const BITBUCKET_TOKEN_SCOPES = [
  "read:user:bitbucket",
  "read:workspace:bitbucket",
  "read:repository:bitbucket",
  "write:repository:bitbucket",
  "read:pullrequest:bitbucket",
  "write:pullrequest:bitbucket",
] as const;
export const BITBUCKET_CREATE_REPO_SCOPE = "admin:repository:bitbucket";

/** An OAuth client ID. Public: it may sit in majhi.yaml. */
export const OAuthClientIdSchema = z
  .string()
  .trim()
  .min(8, "Paste the whole client ID")
  .max(200)
  .regex(/^[A-Za-z0-9._-]+$/, "A client ID has only letters, digits, dots, dashes and underscores");

// ---------------------------------------------------------------------------
// majhi.yaml `git_apps`

/**
 * OAuth apps for the device-flow path, one per host. Written by `git.oauthApps.set`. Only public
 * IDs live here. Optional: without them, sign-in uses the host's CLI or a pasted token.
 *
 * ```yaml
 * git_apps:
 *   github: { client_id: Ov23liAcmeExample01 }
 *   gitlab:
 *     gitlab.acme.test: { client_id: fedcba9876543210fedcba9876543210 }
 * ```
 */
export const GitAppsConfigSchema = z.strictObject({
  /** github.com only. GitHub Enterprise Server is not covered yet. */
  github: z.strictObject({ client_id: OAuthClientIdSchema }).optional(),
  /** By host. gitlab.com and any self-hosted GitLab the owner registered an application on. */
  gitlab: z.record(GitHostNameSchema, z.strictObject({ client_id: OAuthClientIdSchema })).optional(),
  /**
   * Ignored. A Bitbucket OAuth consumer from an older majhi: consumers need workspace admin, so
   * majhi signs in to Bitbucket with an API token instead (DECISIONS 2026-10-03). Kept so an old
   * majhi.yaml still loads.
   */
  bitbucket: z.unknown().optional(),
});
export type GitAppsConfig = z.infer<typeof GitAppsConfigSchema>;

/**
 * The OAuth grant behind a signed-in token, saved as JSON in `secrets.age` under the git account's
 * `oauth` reference. Only GitLab has one: GitHub OAuth App tokens do not expire, and Bitbucket API
 * tokens are pasted. A `bitbucket` grant from an older majhi is not refreshed any more.
 * majhi refreshes the access token before `expiresAt` and rewrites both secrets in place, so the
 * references in majhi.yaml never change and no config commit is made.
 */
export const OAuthGrantSchema = z.strictObject({
  v: z.literal(1),
  kind: MrHostSchema,
  host: GitHostNameSchema,
  /** The client ID the grant was made with (majhi's, or `GLAB_CLIENT_ID`). Refreshing needs the same one. */
  clientId: OAuthClientIdSchema,
  refreshToken: z.string().min(1).max(4096),
  /** When the access token stops working. */
  expiresAt: z.iso.datetime(),
  scope: z.string().max(500).optional(),
});
export type OAuthGrant = z.infer<typeof OAuthGrantSchema>;

// ---------------------------------------------------------------------------
// git.oauthApps.get / git.oauthApps.set

/** What majhi has for each host's app. */
export const GitAppsViewSchema = z.object({
  /** `builtIn`: the ID is majhi's own (`BUILT_IN_OAUTH_APPS`), not one this install saved. */
  github: z.object({ clientId: z.string().optional(), builtIn: z.boolean().optional() }),
  gitlab: z.array(z.object({ host: z.string(), clientId: z.string(), builtIn: z.boolean().optional() })),
});
export type GitAppsView = z.infer<typeof GitAppsViewSchema>;

/** One host's app. `null` removes it; tokens already saved keep working until they expire. */
export const GitAppsSetInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github"), clientId: OAuthClientIdSchema.nullable() }),
  z.object({
    kind: z.literal("gitlab"),
    host: GitHostNameSchema.default(DEFAULT_GIT_HOST.gitlab),
    clientId: OAuthClientIdSchema.nullable(),
  }),
]);
export type GitAppsSetInput = z.input<typeof GitAppsSetInputSchema>;

// ---------------------------------------------------------------------------
// The paste-a-token help

/**
 * Why a sign-in asks for a pasted token instead of a browser sign-in:
 * - `bitbucket`: Bitbucket always takes an Atlassian API token.
 * - `no-cli`: the host's CLI (`gh`, `glab`) is not installed on this computer.
 * - `no-helper`: the host helper is not connected, so majhi cannot run the CLI.
 * - `self-hosted`: a GitLab other than gitlab.com.
 * - `chosen`: the owner asked to paste one.
 */
export const PasteReasonSchema = z.enum(["bitbucket", "no-cli", "no-helper", "self-hosted", "chosen"]);
export type PasteReason = z.infer<typeof PasteReasonSchema>;

/** How to make a token on a host, for the UI to show as is. Shared so the server and UI agree. */
export const GitTokenHelpSchema = z.object({
  kind: MrHostSchema,
  host: z.string(),
  /** The host page that makes the token, prefilled where the host allows it. */
  link: z.object({ label: z.string(), url: z.url() }),
  /** Plain sentences, in order. */
  steps: z.array(z.string()).min(1),
  /** Scope names to tick, when the page does not tick them itself. */
  scopes: z.array(z.string()),
  /** The fields the form asks for. Bitbucket needs the Atlassian account email too. */
  fields: z.array(z.enum(["email", "token"])).min(1),
  /** One line on why it is a token this time, and how to sign in in the browser next time. */
  note: z.string().optional(),
  /** Where to get the host's CLI, when its absence is why it is a token. */
  install: z.object({ label: z.string(), url: z.url() }).optional(),
});
export type GitTokenHelp = z.infer<typeof GitTokenHelpSchema>;

const CLI_NAME = { github: "gh", gitlab: "glab" } as const;
const CLI_INSTALL = {
  github: "https://cli.github.com",
  gitlab: "https://gitlab.com/gitlab-org/cli#installation",
} as const;

/** The token name majhi suggests: `majhi-<workspace>`. */
export function tokenName(workspace: string): string {
  return `majhi-${workspace}`;
}

/**
 * How to make a token for `workspace` on a host: a prefilled page and the exact steps. Names no
 * operating system. Checked against the host docs on 2026-10-03:
 * - https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
 * - https://docs.gitlab.com/user/profile/personal_access_tokens/
 * - https://support.atlassian.com/bitbucket-cloud/docs/create-an-api-token/
 */
export function gitTokenHelp(
  kind: z.infer<typeof MrHostSchema>,
  host: string,
  workspace: string,
  reason: PasteReason,
): GitTokenHelp {
  const name = encodeURIComponent(tokenName(workspace));
  const cliNote =
    kind === "bitbucket"
      ? undefined
      : reason === "no-cli"
        ? `${CLI_NAME[kind]} is not installed on this computer, so majhi asks for a token. Install ${CLI_NAME[kind]} and majhi signs in through the browser next time.`
        : reason === "no-helper"
          ? "The host helper is not connected, so majhi cannot open the browser sign-in. A token works the same."
          : reason === "self-hosted"
            ? `majhi signs in to ${host} with a personal access token.`
            : undefined;
  const install =
    kind !== "bitbucket" && reason === "no-cli"
      ? { install: { label: `Install ${CLI_NAME[kind]}`, url: CLI_INSTALL[kind] } }
      : {};
  if (kind === "github") {
    return {
      kind,
      host,
      link: {
        label: "Open GitHub's new token page",
        url: `https://github.com/settings/tokens/new?description=${name}&scopes=${GITHUB_TOKEN_SCOPES.join(",")}`,
      },
      steps: [
        "Open GitHub's new token page, signed in as the account this workspace uses. majhi fills in the name and the scopes.",
        "Pick an expiration.",
        "Click Generate token at the bottom of the page.",
        "Copy the token and paste it here. GitHub shows it only once.",
      ],
      scopes: [...GITHUB_TOKEN_SCOPES],
      fields: ["token"],
      ...(cliNote === undefined ? {} : { note: cliNote }),
      ...install,
    };
  }
  if (kind === "gitlab") {
    return {
      kind,
      host,
      link: {
        label: `Open personal access tokens on ${host}`,
        url: `https://${host}/-/user_settings/personal_access_tokens?name=${name}&scopes=${GITLAB_TOKEN_SCOPES.join(",")}`,
      },
      steps: [
        `Open the personal access tokens page on ${host}, signed in as the account this workspace uses. majhi fills in the name and the scopes.`,
        "If GitLab asks which kind of token, choose Legacy token.",
        "Set an expiration date.",
        "Click Generate token.",
        "Copy the token and paste it here. GitLab shows it only once.",
      ],
      scopes: [...GITLAB_TOKEN_SCOPES],
      fields: ["token"],
      ...(cliNote === undefined ? {} : { note: cliNote }),
      ...install,
    };
  }
  return {
    kind,
    host,
    link: {
      label: "Open Atlassian API tokens",
      url: "https://id.atlassian.com/manage-profile/security/api-tokens",
    },
    steps: [
      "Open the API tokens page of your Atlassian account, signed in as the account this workspace uses. No admin access is needed.",
      "Click Create API token with scopes.",
      `Name it ${tokenName(workspace)}, pick an expiry date, and click Next.`,
      "Choose Bitbucket as the app, and click Next.",
      "Tick the scopes below, and click Next.",
      "Click Create token. Copy it and paste it here with your Atlassian email. Atlassian shows it only once.",
    ],
    scopes: [...BITBUCKET_TOKEN_SCOPES],
    fields: ["email", "token"],
    note: `Add ${BITBUCKET_CREATE_REPO_SCOPE} too if majhi should make new repos.`,
  };
}

// ---------------------------------------------------------------------------
// git.signIn.start / git.signIn.poll / git.signIn.cancel

/** One sign-in flow. Made by `git.signIn.start`; flows live in memory and end within 15 minutes. */
export const SignInIdSchema = z.string().regex(/^si_[A-Za-z0-9]{12,32}$/, "Not a sign-in id");
export type SignInId = z.infer<typeof SignInIdSchema>;

export const SignInStartInputSchema = z.object({
  /** The workspace the token is for. Only this workspace gets it. */
  org: IdSchema,
  kind: MrHostSchema,
  /** Default: `DEFAULT_GIT_HOST[kind]`. A self-hosted GitLab answers `paste`. */
  host: GitHostNameSchema.optional(),
});

/**
 * - `device` (GitHub through `gh`, or majhi's own device flow): show `userCode` and open
 *   `verificationUri`. Follow the flow with `git.signIn.poll` and the `signins` events topic.
 * - `browser` (GitLab through `glab`): the host's page is open in the browser; the sign-in ends
 *   by itself once the owner approves there. `authorizeUrl` is the link to show when it is not.
 * - `paste`: no browser sign-in this time. Show `gitTokenHelp(kind, host, org, reason)` and send the
 *   token with `git.signIn.token`.
 * `opened` is true when the host helper opened the page; otherwise the UI shows the link to click.
 */
export const SignInStartSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("device"),
    signIn: SignInIdSchema,
    kind: z.enum(["github", "gitlab"]),
    host: z.string(),
    /** The short code the owner types on the host's page, like `WDJB-MJHT`. Not a secret on its own. */
    userCode: z.string(),
    verificationUri: z.url(),
    /** GitLab: the same page with the code filled in. */
    verificationUriComplete: z.url().optional(),
    expiresAt: z.iso.datetime(),
    opened: z.boolean(),
  }),
  z.object({
    state: z.literal("browser"),
    signIn: SignInIdSchema,
    kind: z.enum(["github", "gitlab"]),
    host: z.string(),
    /** The host's authorize page. Holds no secret. */
    authorizeUrl: z.url(),
    expiresAt: z.iso.datetime(),
    opened: z.boolean(),
  }),
  z.object({
    state: z.literal("paste"),
    kind: MrHostSchema,
    host: z.string(),
    reason: PasteReasonSchema,
  }),
]);
export type SignInStart = z.infer<typeof SignInStartSchema>;

const SignInBase = z.object({
  signIn: SignInIdSchema,
  org: IdSchema,
  kind: MrHostSchema,
  host: z.string(),
});

/**
 * A sign-in flow's state. `pending` moves to exactly one of the others and never back
 * (`confirm` then moves on to `done`, `cancelled` or `expired`):
 * - `done`: the token is saved for `org` and checked with the host's user API as `account`.
 * - `denied`: the owner refused on the host's page.
 * - `expired`: the code or the authorize link ran out (15 minutes at most).
 * - `cancelled`: `git.signIn.cancel`, or a new start for the same workspace and host.
 * - `failed`: anything else, with a plain `reason` that never holds a token or a code.
 */
export const SignInStatusSchema = z.discriminatedUnion("state", [
  SignInBase.extend({
    state: z.literal("pending"),
    expiresAt: z.iso.datetime(),
    userCode: z.string().optional(),
    verificationUri: z.url().optional(),
    authorizeUrl: z.url().optional(),
  }),
  SignInBase.extend({
    state: z.literal("done"),
    /** Who the token belongs to, from the host's user API. */
    account: z.string(),
    /** Other workspaces that already use this account on this host. The UI warns; the token is still saved. */
    alsoUsedBy: z.array(IdSchema),
    /** The account this workspace used on this host before, when it was another one. */
    replaced: z.string().optional(),
  }),
  /**
   * The host accepted the sign-in, but `account` is already used by other workspaces. Nothing is
   * saved yet: `git.signIn.confirm` saves it and moves to `done`; `git.signIn.cancel` drops it.
   * It ends as `expired` when nobody answers before `expiresAt`.
   */
  SignInBase.extend({
    state: z.literal("confirm"),
    account: z.string(),
    alsoUsedBy: z.array(IdSchema).min(1),
    replaced: z.string().optional(),
    expiresAt: z.iso.datetime(),
  }),
  SignInBase.extend({ state: z.literal("denied") }),
  SignInBase.extend({ state: z.literal("expired") }),
  SignInBase.extend({ state: z.literal("cancelled") }),
  SignInBase.extend({ state: z.literal("failed"), reason: z.string() }),
]);
export type SignInStatus = z.infer<typeof SignInStatusSchema>;
export type SignInState = SignInStatus["state"];

/** States a flow never leaves. */
export const SIGN_IN_ENDED: ReadonlySet<SignInState> = new Set<SignInState>([
  "done",
  "denied",
  "expired",
  "cancelled",
  "failed",
]);

export const SignInRefSchema = z.object({ signIn: SignInIdSchema });

/** `git.signOut`: removes a workspace's signed-in token for one host. */
export const SignOutInputSchema = z.object({
  org: IdSchema,
  kind: MrHostSchema,
  host: GitHostNameSchema.optional(),
});

/**
 * - `revoked`: the host revoked the token too (GitLab).
 * - `local`: majhi removed it, but the host offers no revoke majhi can call (GitHub without a client
 *   secret, Bitbucket). `revokeUrl` is the host page where the owner can remove majhi's access.
 * - `failed`: majhi removed it, and the host's revoke call did not go through.
 */
export const SignOutSchema = z.object({
  org: IdSchema,
  kind: MrHostSchema,
  host: z.string(),
  /** The account whose token was removed, when there was one. */
  account: z.string().optional(),
  removed: z.boolean(),
  revoke: z.enum(["revoked", "local", "failed"]),
  revokeUrl: z.url().optional(),
});
export type SignOut = z.infer<typeof SignOutSchema>;

/**
 * `git.signIn.token`: a pasted token for one workspace and host. majhi asks the host who it belongs
 * to before anything is saved, then saves it exactly as a browser sign-in would (with the same
 * confirm when another workspace uses that account). Bitbucket takes an Atlassian API token with
 * the Atlassian account email.
 */
export const SignInTokenInputSchema = z
  .object({
    org: IdSchema,
    kind: MrHostSchema,
    host: GitHostNameSchema.optional(),
    /** Sent once, saved in `secrets.age`, never returned, logged or put in an event. */
    token: z
      .string()
      .trim()
      .min(8, "Paste the whole token")
      .max(4096)
      .regex(/^\S+$/, "A token has no spaces"),
    /** Bitbucket only: the Atlassian account email the API token belongs to. */
    email: z.email("Use the email of your Atlassian account").max(320).optional(),
  })
  .refine((v) => v.kind !== "bitbucket" || v.email !== undefined, {
    message: "Bitbucket needs the email of your Atlassian account",
    path: ["email"],
  });
export type SignInTokenInput = z.infer<typeof SignInTokenInputSchema>;

/** majhi's address when nothing else is known: the default port on loopback. */
export const DEFAULT_MAJHI_ORIGIN = "http://127.0.0.1:7070";
