import { z } from "zod";

/**
 * Command-line tools a workspace signs in to with the tool's own login (SPEC 5.14, "Command-line
 * tools"). Each workspace's sign-in lives in a folder of its own, `<MAJHI_HOME>/connections/<id>/
 * profile`, so two workspaces can be signed in to different accounts. Only that workspace's runs
 * mount it, with the variables below pointing inside it. majhi's own environment never reaches a
 * login or a run.
 *
 * The command lines come from each tool's documentation (docs/briefs and the integration research),
 * not from a run against a real install. They are data here so a change is one edit.
 */

export const CliToolIdSchema = z.enum(["wrangler", "vercel", "stripe", "aws", "gcloud", "sentry"]);
export type CliToolId = z.infer<typeof CliToolIdSchema>;

export interface CliToolDef {
  id: CliToolId;
  name: string;
  /** The program, found on the owner's computer for the login and in the runner image for runs. */
  binary: string;
  summary: string;
  /** The tool's own login. */
  login: readonly string[];
  /** A read-only command that tells who is signed in. Exit 0 means the sign-in works. */
  check: readonly string[];
  /** Ends the sign-in at the service where the tool can. */
  logout: readonly string[];
  /** The tool waits for Enter before it opens the browser. */
  enter: boolean;
  /** What a sign-in gives the agents, in plain words. A tool's login is the account's own. */
  access: string;
  /** What was and was not confirmed about the command lines. */
  note: string;
  docs: string;
  /** The variables that point the tool at the profile folder, for the login and for runs. */
  vars: (profile: string) => Record<string, string>;
}

const xdg = (profile: string) => ({
  XDG_CONFIG_HOME: `${profile}/xdg/config`,
  XDG_DATA_HOME: `${profile}/xdg/data`,
  XDG_STATE_HOME: `${profile}/xdg/state`,
  XDG_CACHE_HOME: `${profile}/xdg/cache`,
});

const TOOLS: readonly CliToolDef[] = [
  {
    id: "wrangler",
    name: "Cloudflare (wrangler)",
    binary: "wrangler",
    summary: "Workers, Pages and the account's settings",
    login: ["login"],
    check: ["whoami"],
    logout: ["logout"],
    enter: false,
    access: "Whatever your Cloudflare account can do. Deploys and changes ask you first.",
    note: "Opens a browser page on this computer. Command line taken from the documentation.",
    docs: "https://developers.cloudflare.com/workers/wrangler/commands/general/",
    vars: (p) => ({ XDG_CONFIG_HOME: xdg(p).XDG_CONFIG_HOME }),
  },
  {
    id: "vercel",
    name: "Vercel CLI",
    binary: "vercel",
    summary: "Projects, deployments and environment variables",
    login: ["login"],
    check: ["whoami"],
    logout: ["logout"],
    enter: false,
    access: "Whatever your Vercel account can do. Deploys and changes ask you first.",
    note: "Device code: majhi shows the code and the page. Command line taken from the documentation.",
    docs: "https://vercel.com/docs/cli",
    vars: (p) => ({ XDG_DATA_HOME: xdg(p).XDG_DATA_HOME }),
  },
  {
    id: "stripe",
    name: "Stripe CLI",
    binary: "stripe",
    summary: "Payments, events and a restricted key valid for 90 days",
    login: ["login"],
    check: ["config", "--list"],
    logout: ["logout", "--all"],
    enter: true,
    access: "A restricted key for your Stripe account. Anything that moves money asks you first.",
    note: "Pairing code in the browser. The key lasts 90 days, then sign in again.",
    docs: "https://docs.stripe.com/stripe-cli/keys",
    vars: (p) => ({ XDG_CONFIG_HOME: xdg(p).XDG_CONFIG_HOME }),
  },
  {
    id: "aws",
    name: "AWS",
    binary: "aws",
    summary: "Your AWS account through the CLI",
    login: ["login"],
    check: ["sts", "get-caller-identity", "--output", "text"],
    logout: ["logout"],
    enter: false,
    access: "Whatever the signed-in AWS identity can do. Prefer a read-only role. Changes ask you first.",
    note: "Needs AWS CLI 2.32 or later. Sessions last up to 12 hours. Runs see the config files; the single sign-on cache stays on this computer.",
    docs: "https://docs.aws.amazon.com/sdkref/latest/guide/access-login.html",
    vars: (p) => ({
      AWS_CONFIG_FILE: `${p}/aws/config`,
      AWS_SHARED_CREDENTIALS_FILE: `${p}/aws/credentials`,
    }),
  },
  {
    id: "gcloud",
    name: "Google Cloud",
    binary: "gcloud",
    summary: "Your Google Cloud projects through gcloud",
    login: ["auth", "login"],
    check: ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"],
    logout: ["auth", "revoke", "--all"],
    enter: false,
    access: "Whatever the signed-in account can do. Prefer a viewer role. Changes ask you first.",
    note: "Opens a browser page on this computer. Command line taken from the documentation.",
    docs: "https://cloud.google.com/sdk/gcloud/reference/auth/login",
    vars: (p) => ({ CLOUDSDK_CONFIG: `${p}/gcloud` }),
  },
  {
    id: "sentry",
    name: "Sentry CLI",
    binary: "sentry",
    summary: "Errors, releases and source maps",
    login: ["auth", "login"],
    check: ["auth", "status"],
    logout: ["auth", "logout"],
    enter: false,
    access: "Whatever your Sentry account can do. Changes ask you first.",
    note: "Device code. The new Sentry CLI's command line was not confirmed against an install.",
    docs: "https://docs.sentry.io/cli/",
    vars: (p) => ({
      XDG_CONFIG_HOME: xdg(p).XDG_CONFIG_HOME,
      XDG_DATA_HOME: xdg(p).XDG_DATA_HOME,
    }),
  },
];

export const CLI_TOOLS: Readonly<Record<CliToolId, CliToolDef>> = Object.fromEntries(
  TOOLS.map((t) => [t.id, t]),
) as Record<CliToolId, CliToolDef>;

export function cliTool(id: string): CliToolDef | undefined {
  return (CLI_TOOLS as Record<string, CliToolDef | undefined>)[id];
}

/** The folder name of a connection's CLI sign-in. `isProfile` in the runner's mount check wants this name. */
export const CLI_PROFILE_DIR = "profile";

/**
 * What a run of the workspace gets: only the tool's own variables, pointing into its profile. Never
 * HOME and never anything of majhi's.
 */
export function cliRunEnv(tool: CliToolDef, profile: string): Record<string, string> {
  return tool.vars(profile);
}

/**
 * What a login runs with: the same variables, plus a HOME and the XDG folders inside the profile,
 * so nothing is read from or written to the owner's own folders.
 */
export function cliLoginEnv(tool: CliToolDef, profile: string): Record<string, string> {
  return { HOME: `${profile}/home`, ...xdg(profile), ...tool.vars(profile) };
}

/** Folders a login needs to exist, inside the profile. */
export function cliProfileFolders(profile: string): string[] {
  return [
    `${profile}/home`,
    `${profile}/xdg/config`,
    `${profile}/xdg/data`,
    `${profile}/xdg/state`,
    `${profile}/xdg/cache`,
    `${profile}/aws`,
    `${profile}/gcloud`,
  ];
}
