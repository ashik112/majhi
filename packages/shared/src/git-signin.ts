import { z } from "zod";
import { IdSchema, MrHostSchema, SecretRefSchema } from "./accounts.ts";

/**
 * Git sign-in per workspace (org in code). The owner signs a workspace in to GitHub, GitLab or
 * Bitbucket in the browser; majhi saves the token for that workspace only, in `secrets.age`, and
 * points the workspace's git account and `mr_tokens` at it, so Ship, MRs and push use it.
 *
 * - GitHub: OAuth device flow with the public client ID of one OAuth App (`git_apps.github`).
 * - GitLab: OAuth device authorization grant with a public application ID per host
 *   (`git_apps.gitlab`), GitLab 17.3 or later. Tokens last about 2 hours; majhi refreshes them.
 * - Bitbucket: OAuth authorization code (no PKCE: Bitbucket documents none) with a redirect to majhi's own
 *   `/oauth/bitbucket/callback`, using the per-install consumer (`git_apps.bitbucket`).
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
 * Public client IDs of the OAuth apps the majhi project registers, used when majhi.yaml `git_apps`
 * names none. Device flow needs no client secret, so these are safe to ship. Empty until the apps
 * are registered: then `git.oauthApps.get` reports the host as not set up and `git.signIn.start`
 * answers `needs-app`. `git.oauthApps.set` overrides them per install.
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

/** An OAuth client ID or Bitbucket consumer key. Public: it may sit in majhi.yaml. */
export const OAuthClientIdSchema = z
  .string()
  .trim()
  .min(8, "Paste the whole client ID")
  .max(200)
  .regex(/^[A-Za-z0-9._-]+$/, "A client ID has only letters, digits, dots, dashes and underscores");

// ---------------------------------------------------------------------------
// majhi.yaml `git_apps`

/**
 * The OAuth apps majhi signs in with, one per host. Written by `git.oauthApps.set`. Only public
 * values live here; the Bitbucket consumer secret is a `secret:` reference into `secrets.age`.
 *
 * ```yaml
 * git_apps:
 *   github: { client_id: Ov23liAcmeExample01 }
 *   gitlab:
 *     gitlab.com: { client_id: 0123456789abcdef0123456789abcdef }
 *     gitlab.acme.test: { client_id: fedcba9876543210fedcba9876543210 }
 *   bitbucket: { key: AcmeConsumerKey01, secret: secret:bitbucket-oauth-consumer }
 * ```
 */
export const GitAppsConfigSchema = z.strictObject({
  /** github.com only. GitHub Enterprise Server is not covered yet. */
  github: z.strictObject({ client_id: OAuthClientIdSchema }).optional(),
  /** By host. gitlab.com and any self-hosted GitLab the owner registered an application on. */
  gitlab: z.record(GitHostNameSchema, z.strictObject({ client_id: OAuthClientIdSchema })).optional(),
  /** bitbucket.org. `secret` names the consumer secret in `secrets.age`. */
  bitbucket: z.strictObject({ key: OAuthClientIdSchema, secret: SecretRefSchema }).optional(),
});
export type GitAppsConfig = z.infer<typeof GitAppsConfigSchema>;

/**
 * The OAuth grant behind a signed-in token, saved as JSON in `secrets.age` under the git account's
 * `oauth` reference. Only GitLab and Bitbucket have one: GitHub OAuth App tokens do not expire.
 * majhi refreshes the access token before `expiresAt` and rewrites both secrets in place, so the
 * references in majhi.yaml never change and no config commit is made.
 */
export const OAuthGrantSchema = z.strictObject({
  v: z.literal(1),
  kind: MrHostSchema,
  host: GitHostNameSchema,
  /** The client ID or consumer key the grant was made with. Refreshing needs the same one. */
  clientId: OAuthClientIdSchema,
  refreshToken: z.string().min(1).max(4096),
  /** When the access token stops working. */
  expiresAt: z.iso.datetime(),
  scope: z.string().max(500).optional(),
});
export type OAuthGrant = z.infer<typeof OAuthGrantSchema>;

// ---------------------------------------------------------------------------
// git.oauthApps.get / git.oauthApps.set

/** What majhi has for each host's app. Never holds the Bitbucket secret. */
export const GitAppsViewSchema = z.object({
  /** `builtIn`: the ID is majhi's own (`BUILT_IN_OAUTH_APPS`), not one this install saved. */
  github: z.object({ clientId: z.string().optional(), builtIn: z.boolean().optional() }),
  gitlab: z.array(z.object({ host: z.string(), clientId: z.string(), builtIn: z.boolean().optional() })),
  bitbucket: z.object({ key: z.string().optional(), secretSaved: z.boolean() }),
  /** majhi's own address as the browser reaches it, like `http://127.0.0.1:7070`. */
  origin: z.string(),
  /** The redirect URL to register for Bitbucket: `<origin>/oauth/bitbucket/callback`. */
  bitbucketCallback: z.string(),
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
  z.object({
    kind: z.literal("bitbucket"),
    consumer: z
      .object({
        key: OAuthClientIdSchema,
        /** Sent once, saved in `secrets.age`, never returned, logged or written to majhi.yaml. */
        secret: z.string().trim().min(8).max(512),
      })
      .nullable(),
  }),
]);
export type GitAppsSetInput = z.input<typeof GitAppsSetInputSchema>;

// ---------------------------------------------------------------------------
// The "needs-app" setup steps

/** Exact steps to register majhi's app on a host, for the UI to show as they are. */
export const GitAppSetupSchema = z.object({
  kind: MrHostSchema,
  host: z.string(),
  title: z.string(),
  /** The host page to open. Opened through the host helper's `openUrl`, or shown as a link. */
  link: z.object({ label: z.string(), url: z.string() }),
  /** Plain sentences, in order. */
  steps: z.array(z.string()).min(1),
  /** Values to copy into the host's form, each with a copy button. */
  values: z.array(z.object({ label: z.string(), value: z.string() })),
  /** The fields the UI asks for, then sends with `git.oauthApps.set`. */
  needs: z.array(z.enum(["clientId", "key", "secret"])).min(1),
});
export type GitAppSetup = z.infer<typeof GitAppSetupSchema>;

/** majhi's address when nothing else is known: the default port on loopback. */
export const DEFAULT_MAJHI_ORIGIN = "http://127.0.0.1:7070";

/** The OAuth redirect path of a host kind. Only Bitbucket uses it; GitHub and GitLab require one on the form. */
export function oauthCallbackUrl(origin: string, kind: z.infer<typeof MrHostSchema>): string {
  return `${origin.replace(/\/+$/, "")}/oauth/${kind}/callback`;
}

/**
 * The setup steps for a host whose app is not registered yet. Shared so the server's `needs-app`
 * answer and any UI preview say the same thing. Names no operating system.
 */
export function gitAppSetup(kind: z.infer<typeof MrHostSchema>, host: string, origin: string): GitAppSetup {
  const callback = oauthCallbackUrl(origin, kind);
  if (kind === "github") {
    return {
      kind,
      host,
      title: "Register majhi on GitHub once",
      link: {
        label: "Open GitHub's new OAuth app page",
        url: "https://github.com/settings/applications/new",
      },
      steps: [
        "Open GitHub's new OAuth app page, signed in as any of your accounts. The app only names majhi; each workspace still signs in as its own account.",
        "Fill in the form with the values below.",
        "Click Register application.",
        "On the app's page, tick Enable Device Flow and click Update application.",
        "Copy the Client ID and paste it here. majhi needs no client secret.",
        "If a GitHub organization limits OAuth app access, an owner of that organization approves majhi once, from the prompt GitHub shows when you sign in.",
      ],
      values: [
        { label: "Application name", value: "majhi" },
        { label: "Homepage URL", value: origin },
        { label: "Authorization callback URL", value: callback },
      ],
      needs: ["clientId"],
    };
  }
  if (kind === "gitlab") {
    return {
      kind,
      host,
      title: `Register majhi on ${host} once`,
      link: { label: `Open ${host} applications`, url: `https://${host}/-/user_settings/applications` },
      steps: [
        `Open the Applications page on ${host}, signed in as any of your accounts. The application only names majhi; each workspace still signs in as its own account.`,
        "Click Add new application and fill in the values below.",
        "Clear the Confidential box.",
        "Tick the api scope.",
        "Click Save application.",
        "Copy the Application ID and paste it here. majhi needs no secret.",
        ...(host === DEFAULT_GIT_HOST.gitlab
          ? []
          : [
              `Signing in from majhi needs GitLab ${GITLAB_DEVICE_GRANT_MIN_VERSION} or later on ${host}. On an older GitLab, paste a personal access token with the api scope instead.`,
            ]),
      ],
      values: [
        { label: "Name", value: "majhi" },
        { label: "Redirect URI", value: callback },
        { label: "Scopes", value: "api" },
      ],
      needs: ["clientId"],
    };
  }
  return {
    kind,
    host,
    title: "Register majhi on Bitbucket once",
    link: { label: "Open your Bitbucket workspaces", url: "https://bitbucket.org/account/workspaces/" },
    steps: [
      "Open your Bitbucket workspaces and pick one you administer. The consumer only names majhi; each workspace in majhi still signs in as its own account.",
      "Click the Settings cog, choose Workspace settings, then under Apps and features choose OAuth consumers, and click Add consumer.",
      "Fill in the values below.",
      "Under Permissions, tick Account: Read, Workspace membership: Read, Projects: Read, Repositories: Admin and Pull requests: Write.",
      "Click Save, then open the new consumer to see its Key and Secret.",
      "Paste the Key and the Secret here. majhi keeps the secret encrypted on this computer.",
    ],
    values: [
      { label: "Name", value: "majhi" },
      { label: "Callback URL", value: callback },
      { label: "URL", value: origin },
    ],
    needs: ["key", "secret"],
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
  /** Default: `DEFAULT_GIT_HOST[kind]`. A self-hosted GitLab needs its own entry in `git_apps.gitlab`. */
  host: GitHostNameSchema.optional(),
});

/**
 * - `needs-app`: the host has no app registered yet. Show `setup`, save with `git.oauthApps.set`,
 *   then start again.
 * - `device` (GitHub, GitLab): show `userCode` and open `verificationUri`. majhi polls the host
 *   itself; follow the flow with `git.signIn.poll` and the `signins` events topic.
 * - `browser` (Bitbucket): open `authorizeUrl`. The host sends the browser back to majhi's
 *   callback, which ends the flow.
 * `opened` is true when the host helper opened the page; otherwise the UI shows the link to click.
 */
export const SignInStartSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("needs-app"),
    kind: MrHostSchema,
    host: z.string(),
    setup: GitAppSetupSchema,
  }),
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
    kind: z.literal("bitbucket"),
    host: z.string(),
    /** The host's authorize page with majhi's key and a one-time `state`. Holds no secret. */
    authorizeUrl: z.url(),
    expiresAt: z.iso.datetime(),
    opened: z.boolean(),
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

/** The query string of `GET /oauth/bitbucket/callback`. Either `code` or `error` comes with `state`. */
export const BitbucketCallbackQuerySchema = z.object({
  state: z.string().min(1).max(200),
  code: z.string().min(1).max(2000).optional(),
  error: z.string().max(200).optional(),
});
export type BitbucketCallbackQuery = z.infer<typeof BitbucketCallbackQuerySchema>;
