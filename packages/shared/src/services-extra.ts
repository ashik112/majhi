/**
 * Catalog entries for services that are not a remote MCP server with self-registration: the
 * provider's own OAuth (loopback with PKCE, or the device grant), apps the owner creates first, and
 * command-line tools. Raw data, parsed by `SERVICE_CATALOG` in `services.ts`.
 *
 * Every address and scope comes from the provider's documentation (the integration research,
 * 2026-10-04). None was run against the real service, so `verified` is false and `verifiedNote` says
 * so. Example names are generic.
 */

import { CLI_TOOLS, type CliToolId } from "./cli-tools.ts";

const DOCS_ONLY =
  "From the provider's documentation, 2026-10-04. Not run against the real service: the first connect is the check.";

const identity = (
  url: string,
  labelPaths: string[][],
  idPaths: string[][],
  more: { method?: "GET" | "POST"; body?: string } = {},
) => ({ url, labelPaths, idPaths, ...more });

const G = "https://www.googleapis.com/auth/";

const google = (
  id: string,
  name: string,
  summary: string,
  test: string,
  scopes: unknown[],
  docs: string,
) => ({
  id,
  name,
  kind: "oauth-loopback",
  summary,
  app: "google",
  ready: true,
  verified: false,
  verifiedNote: `${DOCS_ONLY} Google may block the app until it is published or the account is added as a test user.`,
  packs: ["Social and inbox", "Ops watch"],
  provider: {
    flow: "loopback",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    issuer: "https://accounts.google.com",
    issSent: true,
    pkce: true,
    clientAuth: "secret",
    identityScopes: ["openid", "email"],
    extraAuthParams: { access_type: "offline", prompt: "consent" },
    identity: identity(
      test,
      [["email"], ["emailAddress"], ["user", "emailAddress"]],
      [["id"], ["emailAddress"], ["user", "emailAddress"]],
    ),
    refusedHint:
      "If the Google app is still in Testing, Google ends a sign-in after 7 days. Publish the app in the Google console, then connect again.",
    accessPage: "https://myaccount.google.com/permissions",
  },
  scopes,
  test: { kind: "api", sentence: `Reads ${name} once with the token.` },
  docs,
});

const HOST_NOTE =
  "Checked with the host's own API: who the token belongs to, then one read. Nothing is sent anywhere else.";

export const EXTRA_SERVICES: readonly unknown[] = [
  {
    id: "github",
    name: "GitHub",
    kind: "git-host",
    gitKind: "github",
    summary: "Repositories, issues and pull requests, on github.com or GitHub Enterprise",
    host: {
      default: "github.com",
      label: "GitHub Enterprise host",
      placeholder: "github.acme.test",
      selfHosted: "GitHub Enterprise",
    },
    ready: true,
    verified: false,
    verifiedNote: HOST_NOTE,
    packs: ["Engineering"],
    scopes: [
      {
        id: "repo",
        access: "write",
        sentence:
          "Read and change repositories, issues and pull requests the account can. Pushes and merges ask you first.",
      },
    ],
    test: { kind: "api", sentence: "Asks GitHub who the token belongs to, then lists one repository." },
    docs: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
  },
  {
    id: "gitlab-git",
    name: "GitLab",
    kind: "git-host",
    gitKind: "gitlab",
    summary: "Projects, merge requests and pipelines, on gitlab.com or a self-managed GitLab",
    host: {
      default: "gitlab.com",
      label: "Self-managed GitLab host",
      placeholder: "gitlab.acme.test",
      selfHosted: "GitLab self-managed",
    },
    ready: true,
    verified: false,
    verifiedNote: HOST_NOTE,
    packs: ["Engineering"],
    scopes: [
      {
        id: "api",
        access: "write",
        sentence:
          "Read and change projects, merge requests and pipelines the account can. Pushes and merges ask you first.",
      },
    ],
    test: { kind: "api", sentence: "Asks GitLab who the token belongs to, then lists one project." },
    docs: "https://docs.gitlab.com/user/profile/personal_access_tokens/",
  },
  {
    id: "bitbucket",
    name: "Bitbucket",
    kind: "git-host",
    gitKind: "bitbucket",
    summary: "Repositories and pull requests, on Bitbucket Cloud or Bitbucket Server",
    host: {
      default: "bitbucket.org",
      label: "Bitbucket Server host",
      placeholder: "bitbucket.acme.test",
      selfHosted: "Bitbucket Server",
    },
    ready: true,
    verified: false,
    verifiedNote: `${HOST_NOTE} Cloud takes an Atlassian API token with the account email. Server takes an HTTP access token.`,
    packs: ["Engineering"],
    scopes: [
      {
        id: "repo",
        access: "write",
        sentence:
          "Read and change repositories and pull requests the token can. Pushes and merges ask you first.",
      },
    ],
    test: { kind: "api", sentence: "Asks Bitbucket who the token belongs to, then lists one repository." },
    docs: "https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/",
    note: "git over SSH may already work on this Mac. The API token adds pull requests and the API.",
  },
  {
    id: "linear-key",
    name: "Linear API key",
    alt: "linear",
    kind: "token",
    summary: "A personal API key, for polling and reads the MCP server does not do",
    ready: true,
    verified: false,
    verifiedNote: "Checked with Linear's GraphQL API: the viewer, who the key belongs to.",
    packs: ["Engineering", "Ops watch"],
    token: {
      variable: "LINEAR_API_KEY",
      page: { label: "Open Linear's API settings", url: "https://linear.app/settings/account/security" },
      steps: [
        "Open Linear's security settings, signed in as the account this workspace uses.",
        "Under Personal API keys, choose New API key and name it majhi.",
        "Copy the key and paste it here. Linear shows it only once.",
      ],
      auth: "raw",
      check: {
        url: "https://api.linear.app/graphql",
        method: "POST",
        body: '{"query":"{ viewer { id name email } }"}',
        labelPaths: [
          ["data", "viewer", "email"],
          ["data", "viewer", "name"],
        ],
        did: "Asked Linear who the key belongs to",
      },
      hosts: ["api.linear.app"],
    },
    scopes: [{ id: "key", access: "write", sentence: "Whatever the key's account can do in Linear." }],
    test: { kind: "token", sentence: "Asks Linear who the key belongs to." },
    docs: "https://linear.app/developers/graphql#authentication",
  },
  {
    id: "sentry-token",
    name: "Sentry auth token",
    alt: "sentry",
    kind: "token",
    summary: "A personal auth token, for the CLI and API reads the MCP server does not do",
    ready: true,
    verified: false,
    verifiedNote: "Checked with Sentry's API: it lists one organization the token can read.",
    packs: ["Ops watch", "Engineering"],
    token: {
      variable: "SENTRY_AUTH_TOKEN",
      page: {
        label: "Open Sentry's new token page",
        url: "https://sentry.io/settings/account/api/auth-tokens/new-token/",
      },
      steps: [
        "Open Sentry's new token page, signed in as the account this workspace uses.",
        "Tick the scopes below and create the token.",
        "Copy it and paste it here. Sentry shows it only once.",
      ],
      scopes: ["org:read", "project:read", "event:read"],
      check: {
        url: "https://sentry.io/api/0/organizations/?per_page=1",
        labelPaths: [
          ["0", "slug"],
          ["0", "name"],
        ],
        did: "Listed one organization the token can read",
      },
      hosts: ["sentry.io"],
    },
    scopes: [{ id: "read", access: "read", sentence: "Read organizations, projects, issues and events." }],
    test: { kind: "token", sentence: "Lists one organization with the token." },
    docs: "https://docs.sentry.io/api/auth/",
    note: "For Sentry on sentry.io. Self-hosted Sentry is added as an MCP server by URL.",
  },
  {
    id: "digitalocean-token",
    name: "DigitalOcean token",
    alt: "digitalocean",
    kind: "token",
    summary: "A personal access token, for doctl and the API",
    ready: true,
    verified: false,
    verifiedNote: "Checked with DigitalOcean's API: the account the token belongs to.",
    packs: ["Ops watch"],
    token: {
      variable: "DIGITALOCEAN_ACCESS_TOKEN",
      page: {
        label: "Open DigitalOcean's tokens page",
        url: "https://cloud.digitalocean.com/account/api/tokens/new",
      },
      steps: [
        "Open DigitalOcean's new token page, signed in as the account this workspace uses.",
        "Choose a custom scope with read access, set an expiry and generate the token.",
        "Copy it and paste it here. DigitalOcean shows it only once.",
      ],
      scopes: ["read"],
      check: {
        url: "https://api.digitalocean.com/v2/account",
        labelPaths: [
          ["account", "email"],
          ["account", "uuid"],
        ],
        did: "Asked DigitalOcean which account the token belongs to",
      },
      hosts: ["api.digitalocean.com"],
    },
    scopes: [{ id: "token", access: "read", sentence: "Whatever the token's scopes allow on your account." }],
    test: { kind: "token", sentence: "Asks DigitalOcean which account the token belongs to." },
    docs: "https://docs.digitalocean.com/reference/api/create-personal-access-token/",
    note: "doctl reads this token from the variable, so no doctl login is needed. DigitalOcean's one-click sign-in is the better way.",
  },
  {
    id: "outlook",
    name: "Outlook mail and calendar",
    kind: "oauth-loopback",
    summary: "Microsoft 365 or Outlook.com mail and calendar",
    app: "microsoft",
    ready: true,
    verified: false,
    verifiedNote: `${DOCS_ONLY} Microsoft takes http://localhost as the loopback address, so majhi uses that name for this one.`,
    packs: ["Social and inbox"],
    provider: {
      flow: "loopback",
      authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      issuer: "https://login.microsoftonline.com/",
      issuerPrefix: true,
      pkce: true,
      clientAuth: "none",
      identityScopes: ["offline_access", "User.Read"],
      redirectHost: "localhost",
      identity: identity(
        "https://graph.microsoft.com/v1.0/me",
        [["mail"], ["userPrincipalName"], ["displayName"]],
        [["id"]],
      ),
      tokenVar: "MICROSOFT_GRAPH_TOKEN",
      accessPage: "https://account.microsoft.com/privacy/app-access",
    },
    scopes: [
      {
        id: "read",
        access: "read",
        sentence: "Read your mail and calendar.",
        oauth: ["Mail.Read", "Calendars.Read"],
      },
      {
        id: "draft",
        access: "write",
        sentence: "Write drafts and add calendar events. It does not send mail.",
        oauth: ["Mail.ReadWrite", "Calendars.ReadWrite"],
      },
      {
        id: "send",
        access: "write",
        level: "send",
        sentence: "Send mail as you. Each send still asks you unless the channel allows it.",
        oauth: ["Mail.Send"],
      },
    ],
    test: { kind: "api", sentence: "Asks Microsoft Graph who you are." },
    docs: "https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow",
    note: "Microsoft ends this kind of access after 90 days without use. Microsoft cannot revoke it from majhi: remove it in your Microsoft account.",
  },
  google(
    "gmail",
    "Gmail",
    "Read and draft mail",
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    [
      { id: "read", access: "read", sentence: "Read your mail and labels.", oauth: [`${G}gmail.readonly`] },
      {
        id: "draft",
        access: "write",
        sentence: "Write drafts. It does not send.",
        oauth: [`${G}gmail.compose`],
      },
      {
        id: "send",
        access: "write",
        level: "send",
        sentence: "Send mail as you. Each send still asks you unless the channel allows it.",
        oauth: [`${G}gmail.send`],
      },
    ],
    "https://developers.google.com/gmail/api/auth/scopes",
  ),
  google(
    "google-calendar",
    "Google Calendar",
    "Read and add events",
    "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1",
    [
      {
        id: "read",
        access: "read",
        sentence: "Read your calendars and events.",
        oauth: [`${G}calendar.readonly`],
      },
      { id: "write", access: "write", sentence: "Add and change events.", oauth: [`${G}calendar.events`] },
    ],
    "https://developers.google.com/calendar/api/auth",
  ),
  google(
    "google-drive",
    "Google Drive",
    "Read files and make new ones",
    "https://www.googleapis.com/drive/v3/about?fields=user",
    [
      { id: "read", access: "read", sentence: "Read your files.", oauth: [`${G}drive.readonly`] },
      {
        id: "write",
        access: "write",
        sentence: "Create files and change only the ones majhi made.",
        oauth: [`${G}drive.file`],
      },
    ],
    "https://developers.google.com/drive/api/guides/api-specific-auth",
  ),
  {
    id: "slack",
    name: "Slack",
    kind: "api-key",
    summary: "Channel messages and replies, through your own Slack app",
    app: "slack",
    ready: true,
    verified: false,
    verifiedNote: `${DOCS_ONLY} Slack takes only https redirect URLs, so there is no sign-in majhi can run on this computer. The app's two tokens are pasted once instead.`,
    packs: ["Social and inbox"],
    scopes: [
      {
        id: "read",
        access: "read",
        sentence: "Read messages in channels the app is added to, and see who posted.",
        oauth: [
          "channels:history",
          "groups:history",
          "im:history",
          "mpim:history",
          "channels:read",
          "groups:read",
          "mpim:read",
          "users:read",
          "files:read",
        ],
      },
      {
        id: "write",
        access: "write",
        sentence: "Post replies as the app. Each post asks you first.",
        oauth: ["chat:write"],
      },
    ],
    test: { kind: "token", sentence: "Asks Slack which workspace the app is in." },
    docs: "https://docs.slack.dev/app-manifests/",
  },
  {
    id: "telegram",
    name: "Telegram",
    kind: "api-key",
    summary: "A bot in your clients' Telegram groups that reads what they write and replies",
    app: "telegram",
    ready: true,
    verified: false,
    verifiedNote: `${DOCS_ONLY} A Telegram bot has one token, made once in BotFather and pasted here.`,
    packs: ["Social and inbox"],
    scopes: [
      {
        id: "read",
        access: "read",
        sentence: "Read messages in the groups the bot is added to, and see who wrote them.",
      },
      {
        id: "write",
        access: "write",
        sentence: "Send replies as the bot. The Tell setting of the workspace decides who sends.",
      },
    ],
    test: { kind: "token", sentence: "Asks Telegram who the bot is." },
    docs: "https://core.telegram.org/bots/api",
  },
  {
    id: "discord",
    name: "Discord",
    kind: "api-key",
    summary: "A bot in your server that reads and replies",
    app: "discord",
    ready: true,
    verified: false,
    verifiedNote: DOCS_ONLY,
    packs: ["Social and inbox", "Growth"],
    scopes: [
      {
        id: "read",
        access: "read",
        sentence: "See channels and read message history where the bot is added.",
      },
      { id: "write", access: "write", sentence: "Send messages as the bot. Each message asks you first." },
    ],
    test: { kind: "token", sentence: "Asks Discord who the bot is." },
    docs: "https://discord.com/developers/docs/topics/oauth2#bot-users",
  },
  ...cli(
    "vercel-cli",
    "Vercel CLI",
    "Projects and deployments",
    ["Ops watch", "Engineering"],
    "vercel",
    "vercel",
  ),
  ...cli(
    "stripe-cli",
    "Stripe CLI",
    "Payments and a 90-day restricted key",
    ["Growth", "Analysis"],
    "stripe",
    "stripe",
  ),
  ...cli("aws", "AWS", "Your AWS account", ["Ops watch"]),
  ...cli("gcloud", "Google Cloud", "Your Google Cloud projects", ["Ops watch"]),
  ...cli("az", "Azure", "Your Azure subscriptions", ["Ops watch"]),
];

function cli(
  id: string,
  name: string,
  summary: string,
  packs: string[],
  tool: CliToolId = id as CliToolId,
  alt?: string,
): unknown[] {
  const def = CLI_TOOLS[tool];
  return [
    {
      id,
      name,
      kind: "cli-login",
      summary,
      cli: tool,
      ...(alt === undefined ? {} : { alt }),
      ready: true,
      verified: false,
      verifiedNote: `${def.note} The check command's exit code decides, so a signed-out tool cannot read as connected.`,
      packs,
      scopes: [{ id: "account", access: "write", sentence: def.access }],
      test: { kind: "cli", sentence: "Runs the tool's own who-am-I command." },
      docs: def.docs,
    },
  ];
}
