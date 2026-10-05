import { z } from "zod";
import { CliToolIdSchema } from "./cli-tools.ts";
import { IdSchema } from "./ids.ts";
import { EXTRA_SERVICES } from "./services-extra.ts";

/**
 * The service catalog (SPEC 5.14, "Connect"): the outside services majhi can join with one click,
 * as data. A new service is one entry here. Nothing in an entry is a secret: majhi registers
 * itself with each service (dynamic client registration), so there is no client ID or secret to
 * ship.
 */

/**
 * How majhi joins the service.
 * - `mcp-oauth`: a remote MCP server that signs majhi in with OAuth 2.1 and lets it register itself.
 * - `oauth-loopback`: the service's own OAuth, redirect to majhi's loopback address.
 * - `device`: the device authorization grant.
 * - `cli-login`: the service's own command line sign-in, in a folder of the workspace.
 * - `api-key`: a key, entered once in a secure input.
 * - `token`: a token the owner makes on a page majhi opens, pasted once and checked with a call.
 * - `git-host`: GitHub, GitLab or Bitbucket through majhi's host sign-in, at the public host or a self-hosted one.
 * `api-key` is used for the services whose app gives tokens instead of a sign-in majhi can run
 * (Slack, Discord): the guided setup ends with a secure input.
 */
export const ServiceKindSchema = z.enum([
  "mcp-oauth",
  "oauth-loopback",
  "device",
  "cli-login",
  "api-key",
  "token",
  "git-host",
]);
export type ServiceKind = z.infer<typeof ServiceKindSchema>;

export const SERVICE_KIND_LABEL: Record<ServiceKind, string> = {
  "mcp-oauth": "Sign in with the service",
  "oauth-loopback": "Sign in with the service",
  device: "Sign in with a code",
  "cli-login": "Sign in with its command line",
  "api-key": "Access key",
  token: "Paste a token",
  "git-host": "Sign in to the host",
};

/** What a permission lets majhi's agents do, in plain words. */
export const ServiceScopeSchema = z.object({
  id: z.string().min(1).max(60),
  access: z.enum(["read", "write"]),
  /** One sentence the owner reads on the consent step and on the connected row. */
  sentence: z.string().min(1).max(200),
  /**
   * The service's own scope names that grant it, when the service publishes them. Absent means the
   * service decides what the consent screen offers, and majhi shows what it granted.
   */
  oauth: z.array(z.string().min(1).max(200)).optional(),
  /**
   * `send` scopes are asked for only at the `send` level, which the owner turns on for a pack that
   * sends for them. `readwrite` (drafts, edits) never includes them.
   */
  level: z.literal("send").optional(),
});
export type ServiceScope = z.infer<typeof ServiceScopeSchema>;

/**
 * How majhi talks to a service that has no MCP server: its own OAuth with a public client and PKCE
 * (`loopback`), or the device grant (`device`). Nothing here is a secret: the client ID comes from
 * `BUILT_IN_CONNECT_APPS` or the owner's own app, and a client secret, where the provider needs
 * one, is the owner's and lives in secrets.age.
 */
export const ServiceProviderSchema = z.object({
  flow: z.enum(["loopback", "device"]),
  authorizeUrl: z.url().optional(),
  tokenUrl: z.url(),
  deviceUrl: z.url().optional(),
  revokeUrl: z.url().optional(),
  /** The issuer a callback's `iss` must match, when the provider sends one. */
  issuer: z.string().optional(),
  /** Match `iss` by prefix (Microsoft's issuer carries the tenant). */
  issuerPrefix: z.boolean().default(false),
  /** The provider's callback always carries `iss` (RFC 9207), so its absence is an error. */
  issSent: z.boolean().default(false),
  pkce: z.boolean().default(true),
  /** `none`: a public client, no secret. `secret`: the owner's client secret from their own app. */
  clientAuth: z.enum(["none", "secret"]),
  scopeSeparator: z.enum([" ", ","]).default(" "),
  /** Scopes always asked for, so majhi can tell who signed in. */
  identityScopes: z.array(z.string()).default([]),
  extraAuthParams: z.record(z.string(), z.string()).default({}),
  /** `localhost` for providers that register `http://localhost` and not `127.0.0.1`. */
  redirectHost: z.string().optional(),
  /** Who signed in, and the one cheap read that proves the token works. */
  identity: z.object({
    url: z.url(),
    method: z.enum(["GET", "POST"]).default("GET"),
    body: z.string().optional(),
    labelPaths: z.array(z.array(z.string())).min(1),
    idPaths: z.array(z.array(z.string())).min(1),
  }),
  /** The variable a run gets the short-lived access token in, for a service with no MCP server. */
  tokenVar: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .optional(),
  /** Said on a refused renewal, for a provider whose own setting is the likely cause. */
  refusedHint: z.string().max(240).optional(),
  /** Where the owner removes the app's access when majhi cannot revoke it. */
  accessPage: z.url().optional(),
});
export type ServiceProvider = z.infer<typeof ServiceProviderSchema>;

/** One server of a service that splits its MCP tools by product, all behind the same sign-in. */
export const ServiceProductSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(60),
  mcpUrl: z.url(),
});
export type ServiceProduct = z.infer<typeof ServiceProductSchema>;

/**
 * How a pasted token is made and checked (`token` services). The check is a real call with the
 * token: its HTTP status decides, and the answer must name who the token belongs to.
 */
export const TokenMethodSchema = z.object({
  /** The variable agents get the token in. */
  variable: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  /** The page that makes the token, with scopes ticked where the service allows it. */
  page: z.object({ label: z.string().min(1).max(80), url: z.url() }),
  steps: z.array(z.string().min(1).max(240)).min(1).max(8),
  /** Scope names to tick when the page does not tick them itself. */
  scopes: z.array(z.string().min(1).max(100)).max(12).default([]),
  /** How the token goes in the request: `Bearer`, or the bare token in `Authorization`. */
  auth: z.enum(["bearer", "raw"]).default("bearer"),
  check: z.object({
    url: z.url(),
    method: z.enum(["GET", "POST"]).default("GET"),
    body: z.string().optional(),
    /** Who the token belongs to, in the answer. A missing one makes the check fail as unexpected. */
    labelPaths: z.array(z.array(z.string())).min(1),
    /** What a pass of this call says, in the past tense: "Asked Linear who the key belongs to". */
    did: z.string().min(1).max(120),
  }),
  /** The hosts the token may be sent to. Anything else is refused. */
  hosts: z.array(z.string().min(1).max(100)).min(1).max(3),
});
export type TokenMethod = z.infer<typeof TokenMethodSchema>;

/** A service that also runs at a host the owner enters: GitHub Enterprise, GitLab self-managed, Bitbucket Server. */
export const ServiceHostSchema = z.object({
  /** The public host. */
  default: z.string().min(1).max(100),
  label: z.string().min(1).max(60),
  placeholder: z.string().min(1).max(100),
  /** What a host other than the public one is called. */
  selfHosted: z.string().min(1).max(60),
});
export type ServiceHost = z.infer<typeof ServiceHostSchema>;

export const ServiceEntrySchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(60),
  kind: ServiceKindSchema,
  /** One line: what the service is for. */
  summary: z.string().min(1).max(160),
  /** The remote MCP server's address. With `products`, the one the sign-in is made for. */
  mcpUrl: z.url().optional(),
  /** Servers the owner picks from, all reached with one sign-in. The first ones are picked by default. */
  products: z.array(ServiceProductSchema).max(30).optional(),
  /** Hosts of the service's own API that a watch may read with this sign-in. The token goes nowhere else. */
  apiHosts: z.array(z.string().min(1).max(100)).max(5).optional(),
  /** `mcp-oauth`: the variable a run gets the signed-in token in, for the service's own command-line tool. */
  tokenVar: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .optional(),
  /** The command-line tools `tokenVar` is for, so the gate checks their commands. */
  clis: z.array(z.string().min(1).max(40)).max(5).optional(),
  /** The provider's OAuth, for a service without one the SDK can discover. */
  provider: ServiceProviderSchema.optional(),
  /** The guided app setup (`app-setup.ts`) the owner does first, once per workspace. */
  app: z.string().max(40).optional(),
  /** The command-line tool of a `cli-login` service. */
  cli: CliToolIdSchema.optional(),
  /** The packs of the captain's business engine this service is for, in the owner's words. */
  packs: z.array(z.string().max(40)).max(6).default([]),
  /** `git-host`: which host kind its sign-in is. */
  gitKind: z.enum(["github", "gitlab", "bitbucket"]).optional(),
  /** The service also runs at a host the owner enters. */
  host: ServiceHostSchema.optional(),
  /** `token`: how the token is made and checked. */
  token: TokenMethodSchema.optional(),
  /**
   * This entry is another way to connect the service with this id. The page shows it under "Other
   * ways" on that service's card instead of as a card of its own.
   */
  alt: IdSchema.optional(),
  /** What majhi can connect today. A service that is not ready shows what comes next. */
  ready: z.boolean(),
  /**
   * True when the address answered majhi's own check (an unauthenticated call got 401 with protected
   * resource metadata, and the authorization server accepts dynamic registration). False means it
   * comes from the service's documentation or an assumption and was not checked.
   */
  verified: z.boolean(),
  /** What was checked, or what is still open. */
  verifiedNote: z.string().min(1).max(300),
  scopes: z.array(ServiceScopeSchema).max(12),
  /** The test after connecting: majhi lists the server's tools, which needs a valid token. */
  test: z.object({
    kind: z.enum(["mcp-tools", "api", "cli", "token"]),
    sentence: z.string().min(1).max(160),
  }),
  docs: z.url(),
  /** A plan, region or beta the owner should know about before connecting. */
  note: z.string().max(240).optional(),
  /** The exact setting to turn on when the service refuses a working sign-in. */
  enableHint: z.string().max(300).optional(),
});
export type ServiceEntry = z.infer<typeof ServiceEntrySchema>;

const CHECKED =
  "Checked 2026-10-04: the address answers 401 with protected resource metadata, and sign-in accepts dynamic registration.";

const CHECKED_2 =
  "Checked 2026-10-05: the address answers 401 with protected resource metadata, and sign-in accepts dynamic registration.";

const TOOLS_TEST = (what: string) => ({ kind: "mcp-tools" as const, sentence: what });

/** Remote MCP services with OAuth, from the integration research and a live check of each address. */
export const SERVICE_CATALOG: readonly ServiceEntry[] = z.array(ServiceEntrySchema).parse([
  {
    id: "linear",
    name: "Linear",
    kind: "mcp-oauth",
    summary: "Issues, projects and cycles",
    mcpUrl: "https://mcp.linear.app/mcp",
    ready: true,
    verified: true,
    verifiedNote: CHECKED,
    scopes: [
      { id: "read", access: "read", sentence: "Read issues, projects, comments and teams.", oauth: ["read"] },
      {
        id: "write",
        access: "write",
        sentence: "Create and update issues and comments.",
        oauth: ["read", "write"],
      },
    ],
    test: TOOLS_TEST("Lists Linear's tools."),
    docs: "https://linear.app/docs/mcp",
  },
  {
    id: "sentry",
    name: "Sentry",
    kind: "mcp-oauth",
    summary: "Errors, releases and performance",
    mcpUrl: "https://mcp.sentry.dev/mcp",
    ready: true,
    verified: true,
    verifiedNote: CHECKED,
    scopes: [
      { id: "read", access: "read", sentence: "Read organizations, projects, issues and events." },
      { id: "write", access: "write", sentence: "Update issues, teams and alerts." },
    ],
    test: TOOLS_TEST("Lists Sentry's tools."),
    docs: "https://docs.sentry.io/product/sentry-mcp/",
  },
  {
    id: "notion",
    name: "Notion",
    kind: "mcp-oauth",
    summary: "Pages and databases you pick",
    mcpUrl: "https://mcp.notion.com/mcp",
    ready: true,
    verified: true,
    verifiedNote: CHECKED,
    scopes: [
      { id: "default", access: "read", sentence: "Read the pages you pick on Notion's consent screen." },
      { id: "write", access: "write", sentence: "Create and edit pages in what you picked." },
    ],
    test: TOOLS_TEST("Lists Notion's tools."),
    docs: "https://developers.notion.com/docs/mcp",
  },
  {
    id: "atlassian",
    name: "Atlassian",
    kind: "mcp-oauth",
    summary: "Jira and Confluence",
    mcpUrl: "https://mcp.atlassian.com/v1/mcp/authv2",
    ready: true,
    verified: true,
    verifiedNote: `${CHECKED} The older /v1/sse address stopped after 2026-06-30.`,
    scopes: [
      { id: "read", access: "read", sentence: "Read Jira work and Confluence pages." },
      { id: "write", access: "write", sentence: "Create and update Jira work and Confluence pages." },
    ],
    test: TOOLS_TEST("Lists Atlassian's tools."),
    docs: "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/",
    note: "An Atlassian admin may have to allow the Rovo MCP server for the site.",
  },
  {
    id: "vercel",
    name: "Vercel",
    kind: "mcp-oauth",
    summary: "Projects, deployments and logs",
    mcpUrl: "https://mcp.vercel.com",
    ready: true,
    verified: true,
    verifiedNote: CHECKED,
    scopes: [
      { id: "read", access: "read", sentence: "Read projects, deployments and logs of your team." },
      { id: "write", access: "write", sentence: "Deploy and change project settings." },
    ],
    test: TOOLS_TEST("Lists Vercel's tools."),
    docs: "https://vercel.com/docs/mcp/vercel-mcp",
  },
  {
    id: "cloudflare-observability",
    name: "Cloudflare Observability",
    alt: "cloudflare",
    kind: "mcp-oauth",
    summary: "Workers logs and analytics",
    mcpUrl: "https://observability.mcp.cloudflare.com/mcp",
    ready: true,
    verified: true,
    verifiedNote: `${CHECKED} Cloudflare runs one server per product; this is the observability one. The documentation server answers without sign-in, so it is not listed.`,
    scopes: [
      { id: "read", access: "read", sentence: "Read Workers logs and analytics of the accounts you pick." },
    ],
    test: TOOLS_TEST("Lists Cloudflare Observability's tools."),
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
  },
  {
    id: "stripe",
    name: "Stripe",
    kind: "mcp-oauth",
    summary: "Payments, customers and subscriptions",
    mcpUrl: "https://mcp.stripe.com",
    ready: true,
    verified: true,
    verifiedNote: CHECKED,
    scopes: [
      { id: "read", access: "read", sentence: "Read customers, payments, subscriptions and balances." },
      {
        id: "write",
        access: "write",
        sentence: "Create and change Stripe objects. Moving money always asks you.",
      },
    ],
    test: TOOLS_TEST("Lists Stripe's tools."),
    docs: "https://docs.stripe.com/mcp",
  },
  {
    id: "posthog",
    name: "PostHog",
    kind: "mcp-oauth",
    summary: "Product analytics, flags and experiments",
    mcpUrl: "https://mcp.posthog.com/mcp",
    ready: true,
    verified: true,
    verifiedNote: `${CHECKED} EU Cloud projects use mcp-eu.posthog.com, which was not checked.`,
    scopes: [
      { id: "read", access: "read", sentence: "Read insights, events, experiments and flags." },
      { id: "write", access: "write", sentence: "Create and change insights, flags and experiments." },
    ],
    test: TOOLS_TEST("Lists PostHog's tools."),
    docs: "https://posthog.com/docs/model-context-protocol",
    note: "On PostHog's EU cloud, the server is a different address. Add it as a custom MCP server for now.",
  },
  {
    id: "grafana",
    name: "Grafana Cloud",
    kind: "mcp-oauth",
    summary: "Dashboards, alerts and queries",
    mcpUrl: "https://mcp.grafana.com/mcp",
    ready: true,
    verified: true,
    verifiedNote: CHECKED,
    scopes: [
      {
        id: "read",
        access: "read",
        sentence: "Read dashboards and alerts, and run queries.",
        oauth: ["grafana:read", "grafana:query"],
      },
      {
        id: "write",
        access: "write",
        sentence: "Create and change dashboards and alert rules.",
        oauth: ["grafana:read", "grafana:query", "grafana:write"],
      },
    ],
    test: TOOLS_TEST("Lists Grafana's tools."),
    docs: "https://grafana.com/docs/grafana-cloud/ai-tools/mcp-servers/cloud-mcp/",
    note: "Access tokens last one hour; majhi renews them on its own for 30 days.",
  },
  {
    id: "datadog",
    name: "Datadog",
    kind: "mcp-oauth",
    summary: "Monitors, logs and metrics",
    mcpUrl: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
    ready: true,
    verified: true,
    verifiedNote: `${CHECKED} This is the US1 site; other Datadog sites use their own address, which was not checked. The path says unstable.`,
    scopes: [
      { id: "read", access: "read", sentence: "Read monitors, logs, metrics and incidents." },
      { id: "write", access: "write", sentence: "Mute monitors and change dashboards." },
    ],
    test: TOOLS_TEST("Lists Datadog's tools."),
    docs: "https://docs.datadoghq.com/bits_ai/mcp_server/setup",
    note: "Datadog caps its MCP server at 50,000 tool calls a month.",
  },
  {
    id: "betterstack",
    name: "Better Stack",
    kind: "mcp-oauth",
    summary: "Uptime monitors, incidents and logs",
    mcpUrl: "https://mcp.betterstack.com",
    ready: true,
    verified: true,
    verifiedNote: CHECKED,
    scopes: [
      {
        id: "read",
        access: "read",
        sentence: "Read monitors, incidents and logs.",
        oauth: ["read"],
      },
      {
        id: "write",
        access: "write",
        sentence: "Create and acknowledge incidents and change monitors.",
        oauth: ["read", "write"],
      },
    ],
    test: TOOLS_TEST("Lists Better Stack's tools."),
    docs: "https://betterstack.com/docs/getting-started/integrations/mcp/",
  },
  {
    id: "gitlab",
    name: "GitLab MCP (beta)",
    alt: "gitlab-git",
    kind: "mcp-oauth",
    summary: "Projects, merge requests and pipelines",
    mcpUrl: "https://gitlab.com/api/v4/mcp",
    ready: true,
    verified: true,
    verifiedNote: `${CHECKED} This is gitlab.com; a self-managed GitLab has its own address.`,
    scopes: [
      {
        id: "mcp",
        access: "write",
        sentence: "Use GitLab's MCP tools as you: read and change what your account can.",
        oauth: ["mcp"],
      },
    ],
    test: TOOLS_TEST("Lists GitLab's tools."),
    docs: "https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server",
    note: "Beta. A group Owner turns on MCP client access first. GitLab has one permission for all of it.",
    enableHint:
      "A GitLab Owner of your top-level group turns it on: Settings > GitLab Duo > Change configuration > Turn on Model Context Protocol (MCP) support, or on newer GitLab Settings > General > Permissions and group features > MCP client access > Allow connection to GitLab.",
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    kind: "mcp-oauth",
    summary: "Droplets, Kubernetes, databases, apps and more",
    mcpUrl: "https://accounts.mcp.digitalocean.com/mcp",
    apiHosts: ["api.digitalocean.com"],
    tokenVar: "DIGITALOCEAN_ACCESS_TOKEN",
    clis: ["doctl"],
    products: [
      ["droplets", "Droplets"],
      ["doks", "Kubernetes"],
      ["databases", "Databases"],
      ["apps", "App Platform"],
      ["networking", "Networking"],
      ["spaces", "Spaces"],
      ["volumes", "Volumes"],
      ["docr", "Container Registry"],
      ["functions", "Functions"],
      ["insights", "Monitoring"],
      ["accounts", "Account and billing"],
    ].map(([host, name]) => ({ id: host, name, mcpUrl: `https://${host}.mcp.digitalocean.com/mcp` })),
    ready: true,
    verified: true,
    verifiedNote:
      "Checked 2026-10-04: every product endpoint returns 401 with resource metadata naming cloud.digitalocean.com, which takes PKCE S256 and public registration. One sign-in reaching every product is an owner check.",
    scopes: [
      {
        id: "read",
        access: "read",
        sentence: "Read resources and settings of the products you pick.",
        oauth: ["read"],
      },
      {
        id: "write",
        access: "write",
        sentence: "Create, change and delete resources of the products you pick.",
        oauth: ["read", "write"],
      },
    ],
    test: TOOLS_TEST("Lists the tools of each product."),
    docs: "https://docs.digitalocean.com/reference/mcp/configure-mcp/",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    kind: "mcp-oauth",
    summary: "Workers, DNS, R2, logs and the rest of the Cloudflare API",
    mcpUrl: "https://mcp.cloudflare.com/mcp",
    ready: true,
    verified: true,
    verifiedNote: `${CHECKED_2} Takes dynamic registration and client metadata documents.`,
    scopes: [
      {
        id: "read",
        access: "read",
        sentence: "Read your accounts, zones, Workers and settings.",
        oauth: ["user:read", "account:read"],
      },
    ],
    test: TOOLS_TEST("Lists Cloudflare's tools."),
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    note: "One server for the whole API. It replaces the wrangler login, whose check cannot tell signed in from signed out.",
  },
  {
    id: "neon",
    name: "Neon",
    kind: "mcp-oauth",
    summary: "Postgres projects, branches and queries",
    mcpUrl: "https://mcp.neon.tech/mcp",
    ready: true,
    verified: true,
    verifiedNote: CHECKED_2,
    scopes: [
      { id: "read", access: "read", sentence: "Read projects, branches and run read queries." },
      {
        id: "write",
        access: "write",
        sentence: "Create branches and run schema changes. Each asks you first.",
      },
    ],
    test: TOOLS_TEST("Lists Neon's tools."),
    docs: "https://neon.com/docs/ai/neon-mcp-server",
  },
  {
    id: "paypal",
    name: "PayPal",
    kind: "mcp-oauth",
    summary: "Orders, invoices and transactions",
    mcpUrl: "https://mcp.paypal.com/mcp",
    ready: true,
    verified: true,
    verifiedNote: CHECKED_2,
    scopes: [
      { id: "read", access: "read", sentence: "Read orders, invoices, disputes and transactions." },
      {
        id: "write",
        access: "write",
        sentence: "Create invoices and orders. Moving money always asks you.",
      },
    ],
    test: TOOLS_TEST("Lists PayPal's tools."),
    docs: "https://developer.paypal.com/tools/mcp-server/",
  },
  {
    id: "intercom",
    name: "Intercom",
    kind: "mcp-oauth",
    summary: "Conversations, contacts and help articles",
    mcpUrl: "https://mcp.intercom.com/mcp",
    ready: true,
    verified: true,
    verifiedNote:
      "Checked 2026-10-05: the address answers 401, and its authorization server (at the same host) accepts dynamic registration. It publishes no protected resource metadata, so sign-in discovery uses the server's own metadata.",
    scopes: [
      { id: "read", access: "read", sentence: "Read conversations, contacts and articles." },
      { id: "write", access: "write", sentence: "Reply to conversations and edit contacts." },
    ],
    test: TOOLS_TEST("Lists Intercom's tools."),
    docs: "https://developers.intercom.com/docs/guides/mcp",
    note: "Intercom's MCP server is for US workspaces.",
  },
  {
    id: "canva",
    name: "Canva",
    kind: "mcp-oauth",
    summary: "Designs, folders and brand templates",
    mcpUrl: "https://mcp.canva.com/mcp",
    ready: true,
    verified: true,
    verifiedNote: `${CHECKED_2} Takes dynamic registration and client metadata documents.`,
    scopes: [
      { id: "read", access: "read", sentence: "Read designs, folders and brand templates." },
      { id: "write", access: "write", sentence: "Create and edit designs." },
    ],
    test: TOOLS_TEST("Lists Canva's tools."),
    docs: "https://www.canva.dev/docs/connect/canva-mcp-server-setup/",
  },
  {
    id: "webflow",
    name: "Webflow",
    kind: "mcp-oauth",
    summary: "Sites, pages and CMS content",
    mcpUrl: "https://mcp.webflow.com/mcp",
    ready: true,
    verified: true,
    verifiedNote: CHECKED_2,
    scopes: [
      { id: "read", access: "read", sentence: "Read sites, pages and CMS items you pick." },
      { id: "write", access: "write", sentence: "Edit pages and CMS items. Publishing asks you first." },
    ],
    test: TOOLS_TEST("Lists Webflow's tools."),
    docs: "https://developers.webflow.com/mcp/reference/overview",
  },
  {
    id: "zapier",
    name: "Zapier",
    kind: "mcp-oauth",
    summary: "The actions of your Zapier account",
    mcpUrl: "https://mcp.zapier.com/api/mcp/mcp",
    ready: true,
    verified: true,
    verifiedNote: CHECKED_2,
    scopes: [
      { id: "default", access: "write", sentence: "Run the Zapier actions you allow on Zapier's own page." },
    ],
    test: TOOLS_TEST("Lists Zapier's tools."),
    docs: "https://docs.zapier.com/mcp/home",
    note: "Zapier counts each tool call as tasks of your plan. Its own page picks which actions are on.",
  },
  ...EXTRA_SERVICES,
]);

const BY_ID = new Map(SERVICE_CATALOG.map((s) => [s.id, s]));

export function serviceById(
  id: string,
  catalog: readonly ServiceEntry[] = SERVICE_CATALOG,
): ServiceEntry | undefined {
  return catalog === SERVICE_CATALOG ? BY_ID.get(id) : catalog.find((s) => s.id === id);
}

/** The service whose MCP address this is, so a connection made before its grant still names its service. */
export function serviceByUrl(
  url: string,
  catalog: readonly ServiceEntry[] = SERVICE_CATALOG,
): ServiceEntry | undefined {
  const norm = (u: string) => u.replace(/\/+$/, "");
  return catalog.find(
    (s) =>
      (s.mcpUrl !== undefined && norm(s.mcpUrl) === norm(url)) ||
      (s.products ?? []).some((p) => norm(p.mcpUrl) === norm(url)),
  );
}

/**
 * Public client IDs majhi ships, by service. A public client has no secret, so an ID here is not
 * one. Empty until the project registers its own apps; until then each workspace's owner creates
 * the app under their own account in the guided setup (an app under the owner's name, so billing,
 * verification and rate limits are theirs). Never put a client secret here.
 */
export const BUILT_IN_CONNECT_APPS: Readonly<Record<string, string>> = {};

/** The `oauth` scope names of the permissions that count at `access`. */
export function scopesAt(
  entry: Pick<ServiceEntry, "scopes">,
  access: "read" | "readwrite" | "send",
): ServiceScope[] {
  return entry.scopes.filter(
    (s) => s.access === "read" || access === "send" || (access === "readwrite" && s.level !== "send"),
  );
}
