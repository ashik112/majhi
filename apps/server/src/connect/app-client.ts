import { IdSchema } from "@majhi/shared";
import { z } from "zod";
import type { SecretStore } from "../secrets/store.ts";
import { ConnectError } from "./oauth.ts";

/**
 * The owner's own app for a provider that gives majhi no way to register itself (guided setup,
 * SPEC 5.14): a client ID, and a client secret where the provider needs one. One per app and
 * workspace, in secrets.age, so a client's Google app is never used for another client. Nothing
 * here is logged or returned over HTTP.
 */

const AppClientSchema = z.object({
  v: z.literal(1),
  app: z.string(),
  org: IdSchema,
  clientId: z.string().min(1).max(300),
  clientSecret: z.string().min(1).max(500).optional(),
});
export type AppClient = z.infer<typeof AppClientSchema>;

export const appClientName = (app: string, org: string): string => `appclient-${app}-${org}`;

export class AppClientStore {
  constructor(private readonly secrets: Pick<SecretStore, "get" | "set" | "delete">) {}

  async get(app: string, org: string): Promise<AppClient | undefined> {
    const raw = await this.secrets.get(appClientName(app, org));
    if (raw === undefined) return undefined;
    try {
      const parsed = AppClientSchema.safeParse(JSON.parse(raw));
      // A client is only used for the app and workspace it was saved for.
      return parsed.success && parsed.data.app === app && parsed.data.org === org ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async save(client: AppClient): Promise<void> {
    await this.secrets.set(
      appClientName(client.app, client.org),
      JSON.stringify(AppClientSchema.parse(client)),
    );
  }

  async delete(app: string, org: string): Promise<boolean> {
    const had = (await this.get(app, org)) !== undefined;
    await this.secrets.delete(appClientName(app, org));
    return had;
  }
}

// ---------------------------------------------------------------------------
// Google's client file

const GOOGLE_HOSTS = new Set(["accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com"]);

const ClientFileSchema = z.object({
  client_id: z.string().min(1).max(300),
  client_secret: z.string().min(1).max(500),
  auth_uri: z.string().optional(),
  token_uri: z.string().optional(),
  redirect_uris: z.array(z.string()).optional(),
});

const NOT_GOOGLE =
  "That is not a Google client file. Download the JSON from the client's page and drop it again.";

/**
 * Reads the JSON file Google lets the owner download for an OAuth client. Only a Desktop client
 * (`installed`) is taken: a Web client needs a registered https redirect and a secret that is
 * confidential, which a loopback app cannot honor. The file's own addresses must be Google's: a file
 * that points the token endpoint elsewhere would send the code and the secret there.
 */
export function parseGoogleClientJson(text: string): { clientId: string; clientSecret: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConnectError(NOT_GOOGLE, "protocol");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ConnectError(NOT_GOOGLE, "protocol");
  const root = raw as Record<string, unknown>;
  if ("web" in root && !("installed" in root)) {
    throw new ConnectError(
      "That is a Web client. majhi needs a Desktop app client: create a new client with the type Desktop app and download its JSON.",
      "unsupported",
    );
  }
  const parsed = ClientFileSchema.safeParse(root.installed);
  if (!parsed.success) throw new ConnectError(NOT_GOOGLE, "protocol");
  const file = parsed.data;
  if (!file.client_id.endsWith(".apps.googleusercontent.com")) throw new ConnectError(NOT_GOOGLE, "protocol");
  for (const address of [file.auth_uri, file.token_uri]) {
    if (address === undefined) continue;
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      throw new ConnectError(NOT_GOOGLE, "protocol");
    }
    if (url.protocol !== "https:" || !GOOGLE_HOSTS.has(url.hostname)) {
      throw new ConnectError(
        "That file points somewhere other than Google, so majhi did not use it.",
        "protocol",
      );
    }
  }
  return { clientId: file.client_id, clientSecret: file.client_secret };
}

/** A Slack token of the kind asked for. */
export function checkSlackToken(kind: "bot" | "app", value: string): string {
  const token = value.trim();
  const prefix = kind === "bot" ? "xoxb-" : "xapp-";
  if (!token.startsWith(prefix) || token.length < 20 || /\s/.test(token)) {
    throw new ConnectError(
      kind === "bot"
        ? "The bot token starts with xoxb-. Copy it from OAuth & Permissions."
        : "The app-level token starts with xapp-. Make one under Basic Information, App-Level Tokens.",
      "protocol",
    );
  }
  return token;
}

/** A Discord application ID: a number of 17 to 20 digits. */
export function checkDiscordId(value: string): string {
  const id = value.trim();
  if (!/^\d{17,20}$/.test(id)) {
    throw new ConnectError(
      "The application ID is a number of 17 to 20 digits, from General Information.",
      "protocol",
    );
  }
  return id;
}
