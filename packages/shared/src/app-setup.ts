import { z } from "zod";
import { type ConnectAccess, ConnectAccessSchema } from "./connect.ts";
import { IdSchema } from "./ids.ts";
import { SERVICE_CATALOG, type ServiceEntry, scopesAt } from "./services.ts";

/**
 * Guided app setup (SPEC 5.14, "Connect"): for the services whose provider gives no way for majhi to
 * register itself, the owner creates one app, once per workspace, under their own account. This file
 * is the sheet as data: each step has the exact page to open and the exact values to paste, so the
 * owner never edits a file or runs a command. Everything shown is public; the secrets the owner
 * enters (a client secret, a bot token, a Google client file) go straight into secrets.age.
 */

export const AppSetupInputKindSchema = z.enum(["text", "secret", "google-json"]);

export const AppSetupViewSchema = z.object({
  app: z.string(),
  /** The services this one setup unlocks. */
  services: z.array(z.object({ id: IdSchema, name: z.string() })),
  title: z.string(),
  intro: z.string(),
  appName: z.string(),
  redirect: z.string(),
  /** What the app will be allowed to do, in plain words, at the chosen access. */
  scopes: z.array(z.object({ service: z.string(), access: z.enum(["read", "write"]), sentence: z.string() })),
  steps: z.array(
    z.object({
      n: z.number().int(),
      /** A stable name, so the page can mark a step done and the server can say which step failed. */
      id: z.string().optional(),
      /**
       * A live check the page can run after this step: `client` (the saved client file is a Desktop client),
       * `apis` (each API answers with the stored sign-in), `published` (the app is out of Testing, so its sign-in
       * does not end after 7 days).
       */
      check: z.enum(["client", "apis", "published"]).optional(),
      title: z.string(),
      body: z.string(),
      links: z.array(z.object({ label: z.string(), url: z.string() })),
      /** A value to paste into the provider's form. */
      values: z.array(z.object({ label: z.string(), value: z.string() })),
    }),
  ),
  inputs: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      kind: AppSetupInputKindSchema,
      help: z.string(),
      placeholder: z.string().optional(),
    }),
  ),
  /** The Slack manifest, with a link that opens Slack's "create from manifest" page prefilled. */
  manifest: z.object({ json: z.string(), createUrl: z.string() }).optional(),
  /** `consent`: after saving, the owner connects each service as usual. `tokens`: saving connects it. */
  finishes: z.enum(["consent", "tokens"]),
  /** An app is saved for this workspace, or majhi ships one. */
  saved: z.boolean(),
  builtIn: z.boolean(),
});
export type AppSetupView = z.infer<typeof AppSetupViewSchema>;

export const AppSetupInputSchema = z.object({
  org: IdSchema,
  app: z.string().min(1).max(40),
  access: ConnectAccessSchema.default("read"),
});
export const AppSetupSaveInputSchema = z.object({
  org: IdSchema,
  app: z.string().min(1).max(40),
  /** By input key. Secret values are stored in secrets.age and never returned. */
  values: z.record(z.string(), z.string().max(20_000)),
  access: ConnectAccessSchema.default("read"),
});
export const AppSetupSaveResultSchema = z.object({
  app: z.string(),
  /** What the save did, in one sentence. */
  message: z.string(),
  /** For `tokens` apps: the connection that was made. */
  connection: IdSchema.optional(),
  /** A page to open next, like Discord's add-the-bot link. */
  next: z.object({ label: z.string(), url: z.string() }).optional(),
});
export type AppSetupSaveResult = z.infer<typeof AppSetupSaveResultSchema>;

export const AppSetupForgetInputSchema = z.object({ org: IdSchema, app: z.string().min(1).max(40) });
export const AppSetupStatusSchema = z.array(
  z.object({ app: z.string(), saved: z.boolean(), builtIn: z.boolean() }),
);

interface Def {
  title: string;
  intro: string;
  finishes: "consent" | "tokens";
  services: string[];
  inputs: z.infer<typeof AppSetupViewSchema>["inputs"];
  steps: (c: Ctx) => Omit<z.infer<typeof AppSetupViewSchema>["steps"][number], "n">[];
}

interface Ctx {
  appName: string;
  redirect: string;
  access: ConnectAccess;
  manifestUrl?: string;
}

const step = (
  title: string,
  body: string,
  links: { label: string; url: string }[] = [],
  values: { label: string; value: string }[] = [],
  more: { id?: string; check?: "client" | "apis" | "published" } = {},
) => ({ title, body, links, values, ...more });

/** Slack bot scopes at an access, from the catalog (the one place that names them). */
export function slackBotScopes(access: ConnectAccess): string[] {
  const entry = SERVICE_CATALOG.find((s) => s.id === "slack");
  if (entry === undefined) return [];
  return [...new Set(scopesAt(entry, access).flatMap((s) => s.oauth ?? []))];
}

/** The Slack app manifest. Socket Mode on, so majhi connects out and Slack needs no public address. */
export function slackManifest(appName: string, access: ConnectAccess): Record<string, unknown> {
  return {
    display_information: { name: appName, description: "majhi reads and drafts for this workspace" },
    features: { bot_user: { display_name: appName, always_online: false } },
    oauth_config: { scopes: { bot: slackBotScopes(access) } },
    settings: {
      event_subscriptions: {
        bot_events: ["message.channels", "message.groups", "message.im", "message.mpim"],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

export function slackCreateUrl(manifestJson: string): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(manifestJson)}`;
}

/** The Discord permission bits for the add-the-bot link: view channels and history; sending at write. */
export function discordPermissions(access: ConnectAccess): number {
  const VIEW_CHANNEL = 1 << 10;
  const SEND_MESSAGES = 1 << 11;
  const READ_HISTORY = 1 << 16;
  return access === "read" ? VIEW_CHANNEL | READ_HISTORY : VIEW_CHANNEL | READ_HISTORY | SEND_MESSAGES;
}

export function discordAddBotUrl(applicationId: string, access: ConnectAccess): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&scope=bot&permissions=${discordPermissions(access)}`;
}

const GOOGLE_CONSOLE = "https://console.cloud.google.com";

const DEFS: Readonly<Record<string, Def>> = {
  google: {
    title: "Google app (Gmail, Calendar, Drive)",
    intro:
      "Google gives majhi no app of its own, so you make one in your Google account, once for this workspace. About five minutes. The app stays yours: Google bills nothing and majhi never sees your password.",
    finishes: "consent",
    services: ["gmail", "google-calendar", "google-drive"],
    inputs: [
      {
        key: "clientJson",
        label: "Client file from Google",
        kind: "google-json",
        help: "Drop the JSON file Google lets you download. majhi reads it, keeps it encrypted and never shows it again.",
      },
    ],
    steps: (c) => [
      step(
        "Make a project",
        "Google keeps an app inside a project. Name it as below, or use a project you already have.",
        [{ label: "Open Google Cloud: new project", url: `${GOOGLE_CONSOLE}/projectcreate` }],
        [{ label: "Project name", value: c.appName }],
        { id: "project" },
      ),
      step(
        "Set up the consent screen",
        "Pick External (Internal if this is a Google Workspace you administer) and add your own email. You publish the app in the last step.",
        [{ label: "Open the consent screen", url: `${GOOGLE_CONSOLE}/auth/branding` }],
        [{ label: "App name", value: c.appName }],
        { id: "consent" },
      ),
      step(
        "Add the permissions",
        "Add only the permissions listed under What the app may do, above. Read comes first; the rest only when you turn a pack on.",
        [{ label: "Open Data Access", url: `${GOOGLE_CONSOLE}/auth/scopes` }],
        [],
        { id: "scopes" },
      ),
      step(
        "Make a Desktop client",
        "Choose the type Desktop app. Google accepts majhi's local address for it without you adding one. On the new client, press Download JSON.",
        [{ label: "Open: create client", url: `${GOOGLE_CONSOLE}/auth/clients/create` }],
        [
          { label: "Application type", value: "Desktop app" },
          { label: "Name", value: c.appName },
          { label: "Redirect address", value: c.redirect },
        ],
        { id: "client" },
      ),
      step(
        "Drop the JSON here",
        "majhi reads the file and checks that it is a Desktop client. Then connect Gmail, Calendar or Drive: one sign-in each, all on this same client.",
        [],
        [],
        { id: "json", check: "client" },
      ),
      step(
        "Turn on the APIs",
        "Open each page and press Enable, for the services you connected. majhi then calls each one with your sign-in and shows which answers. A page that is still off shows the exact link to turn on.",
        [
          { label: "Gmail API", url: `${GOOGLE_CONSOLE}/apis/library/gmail.googleapis.com` },
          { label: "Google Calendar API", url: `${GOOGLE_CONSOLE}/apis/library/calendar-json.googleapis.com` },
          { label: "Google Drive API", url: `${GOOGLE_CONSOLE}/apis/library/drive.googleapis.com` },
        ],
        [],
        { id: "apis", check: "apis" },
      ),
      step(
        "Publish the app",
        "While the app is in Testing, Google ends every sign-in after 7 days. Press Publish app, then sign in once more. Google shows an unverified-app warning for your own account: choose Advanced, then continue. majhi checks that the new sign-in no longer expires in 7 days.",
        [{ label: "Open Audience and publish", url: `${GOOGLE_CONSOLE}/auth/audience` }],
        [],
        { id: "publish", check: "published" },
      ),
    ],
  },
  slack: {
    title: "Slack app",
    intro:
      "Slack only takes https redirect addresses, so majhi cannot run its sign-in on this computer. You create the app from a manifest majhi writes, install it, and paste its two tokens once.",
    finishes: "tokens",
    services: ["slack"],
    inputs: [
      {
        key: "botToken",
        label: "Bot token",
        kind: "secret",
        help: "Starts with xoxb-. Slack shows it under OAuth & Permissions after you install the app.",
        placeholder: "xoxb-",
      },
      {
        key: "appToken",
        label: "App-level token",
        kind: "secret",
        help: "Starts with xapp-. Basic Information, App-Level Tokens, with the permission connections:write. Lets majhi listen without a public address.",
        placeholder: "xapp-",
      },
    ],
    steps: (c) => [
      step(
        "Create the app from the manifest",
        "The button opens Slack with everything filled in: the name, the permissions, and Socket Mode. Pick the workspace and press Create.",
        c.manifestUrl === undefined ? [] : [{ label: "Create from manifest", url: c.manifestUrl }],
        [{ label: "App name", value: c.appName }],
      ),
      step("Install it", "On the app's page open Install App, then Install to Workspace, and press Allow.", [
        { label: "Your Slack apps", url: "https://api.slack.com/apps" },
      ]),
      step(
        "Copy the bot token",
        "Open OAuth & Permissions and copy the Bot User OAuth Token. Paste it below.",
      ),
      step(
        "Make the app-level token",
        "Open Basic Information, scroll to App-Level Tokens, press Generate Token and Scopes, add connections:write, and copy the token. Paste it below.",
      ),
    ],
  },
  discord: {
    title: "Discord bot",
    intro:
      "Discord's sign-in gives a person, not a bot that can read a server, so you make a bot once and paste its token. majhi then gives you the one-click link that adds the bot to your server.",
    finishes: "tokens",
    services: ["discord"],
    inputs: [
      {
        key: "applicationId",
        label: "Application ID",
        kind: "text",
        help: "General Information, Application ID. A number, not a secret.",
        placeholder: "123456789012345678",
      },
      {
        key: "botToken",
        label: "Bot token",
        kind: "secret",
        help: "Bot page, Reset Token. Shown by Discord once.",
      },
    ],
    steps: (c) => [
      step(
        "Create the application",
        "Press New Application and name it.",
        [{ label: "Open the Discord developer portal", url: "https://discord.com/developers/applications" }],
        [{ label: "Name", value: c.appName }],
      ),
      step(
        "Open the Bot page",
        "Turn on Message Content Intent so the bot can read what people write. Press Reset Token and copy it.",
      ),
      step(
        "Copy the Application ID",
        "On General Information copy the Application ID. Paste both values below.",
      ),
    ],
  },
  microsoft: {
    title: "Microsoft app (Outlook)",
    intro:
      "Microsoft lets you register an app as a public client, so there is no secret. About three minutes in the Entra portal.",
    finishes: "consent",
    services: ["outlook"],
    inputs: [
      {
        key: "clientId",
        label: "Application (client) ID",
        kind: "text",
        help: "Overview page, a long id with dashes.",
      },
    ],
    steps: (c) => [
      step(
        "Register the app",
        "Pick Accounts in any organizational directory and personal Microsoft accounts.",
        [
          {
            label: "Open Entra: register an application",
            url: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade/isMSAApp~/false",
          },
        ],
        [{ label: "Name", value: c.appName }],
      ),
      step(
        "Add the redirect address",
        "Authentication, Add a platform, Mobile and desktop applications. Microsoft takes localhost, so the name differs from the others.",
        [],
        [{ label: "Redirect URI", value: c.redirect.replace("127.0.0.1", "localhost") }],
      ),
      step(
        "Allow public client flows",
        "On the same Authentication page, set Allow public client flows to Yes.",
      ),
      step(
        "Copy the Application ID",
        "Paste it below. majhi asks for the permissions listed under What it can do when you connect.",
      ),
    ],
  },
};

export const APP_IDS: readonly string[] = Object.keys(DEFS);

export function appForService(serviceId: string): string | undefined {
  return SERVICE_CATALOG.find((s) => s.id === serviceId)?.app;
}

export function appServices(app: string): ServiceEntry[] {
  return SERVICE_CATALOG.filter((s) => s.app === app);
}

/** The name majhi proposes for the owner's app. Plain and recognizable in the provider's list. */
export function appNameFor(orgName: string): string {
  return `majhi (${orgName})`.slice(0, 40);
}

/** The sheet for one app and one workspace. Pure: the server adds `saved` and `builtIn`. */
export function buildAppSetup(
  app: string,
  ctx: { orgName: string; redirect: string; access: ConnectAccess },
): Omit<AppSetupView, "saved" | "builtIn"> | undefined {
  const def = DEFS[app];
  if (def === undefined) return undefined;
  const appName = appNameFor(ctx.orgName);
  const services = appServices(app);
  const manifest =
    app === "slack"
      ? (() => {
          const json = JSON.stringify(slackManifest(appName, ctx.access));
          return { json, createUrl: slackCreateUrl(json) };
        })()
      : undefined;
  const steps = def.steps({
    appName,
    redirect: ctx.redirect,
    access: ctx.access,
    ...(manifest === undefined ? {} : { manifestUrl: manifest.createUrl }),
  });
  return {
    app,
    services: services.map((s) => ({ id: s.id, name: s.name })),
    title: def.title,
    intro: def.intro,
    appName,
    redirect: ctx.redirect,
    scopes: services.flatMap((s) =>
      scopesAt(s, ctx.access).map((sc) => ({ service: s.name, access: sc.access, sentence: sc.sentence })),
    ),
    steps: steps.map((s, i) => ({ ...s, n: i + 1 })),
    inputs: def.inputs,
    ...(manifest === undefined ? {} : { manifest }),
    finishes: def.finishes,
  };
}
