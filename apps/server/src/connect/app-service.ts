import {
  APP_IDS,
  type AppSetupView,
  appServices,
  buildAppSetup,
  type CommandMeta,
  type ConnectAccess,
  type ConnectionConfig,
  type ConnectionFailure,
  type ConnectionTestResult,
  discordAddBotUrl,
  suggestConnectionId,
} from "@majhi/shared";
import { z } from "zod";
import { UserError } from "../errors.ts";
import {
  type AppClientStore,
  checkDiscordId,
  checkSlackToken,
  checkTelegramToken,
  parseGoogleClientJson,
} from "./app-client.ts";
import { ConnectError, type Fetch } from "./oauth.ts";
import type { ConnectConnections } from "./service.ts";

/**
 * The guided app setup behind the Connections page (SPEC 5.14): shows the sheet for a service, saves
 * what the owner pastes or drops (a client ID and secret, Google's client file, Slack's and
 * Discord's tokens) in secrets.age, and for Slack, Telegram and Discord also makes the connection, since a
 * bot token is the whole sign-in. Slack and Telegram make a `chat` connection: only majhi reads it. Values are never logged, returned or put in an error.
 */

const SLACK = "https://slack.com/api";
const DISCORD = "https://discord.com/api/v10";
const TELEGRAM = "https://api.telegram.org";

export interface AppServiceDeps {
  apps: AppClientStore;
  builtIn?: Readonly<Record<string, string>> | undefined;
  githubClientId?: (() => Promise<string | undefined>) | undefined;
  orgName: (org: string) => Promise<string | undefined>;
  redirect: string;
  fetch: () => Fetch;
  /** Telegram's Bot API address. Only a trial against a fake bot server changes it. */
  telegramApi?: string | undefined;
  /** Slack's Web API address. Only a trial against a fake Slack changes it. */
  slackApi?: string | undefined;
  connections: ConnectConnections;
  connectionIds: () => Promise<{ org: string; id: string; connection: ConnectionConfig }[]>;
  /** The value of a secret entry of a connection's `vars`. */
  secretOf: (connection: string, name: string) => Promise<string | undefined>;
  changed: () => void;
  /** Where a connection stands: a setup that asked the service and got a good answer says so. */
  observe?: ((connection: string, result: ConnectionTestResult) => void) | undefined;
  log?: ((line: string) => void) | undefined;
}

type SaveInput = {
  org: string;
  app: string;
  values: Record<string, string>;
  access: ConnectAccess;
};
type SaveResult = {
  app: string;
  message: string;
  connection?: string;
  next?: { label: string; url: string };
};

const trimmed = (values: Record<string, string>, key: string, label: string): string => {
  const value = values[key]?.trim();
  if (value === undefined || value === "") throw new UserError(`${label} is empty.`);
  return value;
};

const ClientIdSchema = z.string().min(6).max(300).regex(/^\S+$/, "A client ID has no spaces");

export class AppService {
  constructor(private readonly deps: AppServiceDeps) {}

  async view(org: string, app: string, access: ConnectAccess): Promise<AppSetupView> {
    const name = await this.deps.orgName(org);
    if (name === undefined) throw new UserError(`Org "${org}" does not exist.`, 404);
    const built = buildAppSetup(app, { orgName: name, redirect: this.deps.redirect, access });
    if (built === undefined) throw new UserError(`There is no app setup ${app}.`, 404);
    const status = (await this.status(org)).find((s) => s.app === app);
    return { ...built, saved: status?.saved ?? false, builtIn: status?.builtIn ?? false };
  }

  async status(org: string): Promise<{ app: string; saved: boolean; builtIn: boolean }[]> {
    const connections = await this.deps.connectionIds();
    const out: { app: string; saved: boolean; builtIn: boolean }[] = [];
    for (const app of APP_IDS) {
      const services = appServices(app);
      const tokenApp = services.some((s) => s.kind === "api-key");
      const saved = tokenApp
        ? connections.some(
            (c) => c.org === org && services.some((s) => s.id === c.connection.fields?.service),
          )
        : (await this.deps.apps.get(app, org)) !== undefined;
      let builtIn = services.some(
        (s) => (this.deps.builtIn?.[s.id] ?? this.deps.builtIn?.[app] ?? "") !== "",
      );
      if (!builtIn && app === "github" && (await this.deps.githubClientId?.()) !== undefined) builtIn = true;
      out.push({ app, saved, builtIn });
    }
    return out;
  }

  async save(input: SaveInput, meta: CommandMeta): Promise<SaveResult> {
    if ((await this.deps.orgName(input.org)) === undefined) {
      throw new UserError(`Org "${input.org}" does not exist.`, 404);
    }
    if (!APP_IDS.includes(input.app)) throw new UserError(`There is no app setup ${input.app}.`, 404);
    try {
      switch (input.app) {
        case "google":
          return await this.saveGoogle(input);
        case "slack":
          return await this.saveSlack(input, meta);
        case "discord":
          return await this.saveDiscord(input, meta);
        case "telegram":
          return await this.saveTelegram(input, meta);
        case "linkedin":
          return await this.saveClient(input, true);
        default:
          return await this.saveClient(input, false);
      }
    } catch (err) {
      if (err instanceof ConnectError) throw new UserError(err.message, 400);
      throw err;
    }
  }

  async forget(org: string, app: string): Promise<{ removed: boolean }> {
    const removed = await this.deps.apps.delete(app, org);
    this.deps.changed();
    return { removed };
  }

  private async saveGoogle(input: SaveInput): Promise<SaveResult> {
    const text = input.values.clientJson;
    if (text === undefined || text.trim() === "") throw new UserError("Drop the client file from Google.");
    const client = parseGoogleClientJson(text);
    await this.deps.apps.save({ v: 1, app: "google", org: input.org, ...client });
    this.deps.changed();
    this.deps.log?.(`connect: google app saved for ${input.org}`);
    return { app: "google", message: "The Google app is saved. Now connect Gmail, Calendar or Drive." };
  }

  private async saveClient(input: SaveInput, withSecret: boolean): Promise<SaveResult> {
    const id = ClientIdSchema.safeParse(trimmed(input.values, "clientId", "The client ID"));
    if (!id.success)
      throw new UserError("That does not look like a client ID: it has spaces or is too short.");
    const secret = withSecret ? trimmed(input.values, "clientSecret", "The client secret") : undefined;
    await this.deps.apps.save({
      v: 1,
      app: input.app,
      org: input.org,
      clientId: id.data,
      ...(secret === undefined ? {} : { clientSecret: secret }),
    });
    this.deps.changed();
    this.deps.log?.(`connect: ${input.app} app saved for ${input.org}`);
    return { app: input.app, message: "The app is saved. Now connect the service." };
  }

  // ------------------------------------------------------------------------
  // Slack and Discord: the tokens are the sign-in

  private async slack<T extends Record<string, unknown>>(
    method: string,
    token: string,
  ): Promise<{ ok: boolean } & T> {
    try {
      const base = (this.deps.slackApi ?? SLACK).replace(/\/+$/, "");
      const res = await this.deps.fetch()(`${base}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      const body: unknown = await res.json();
      if (typeof body !== "object" || body === null) return { ok: false } as { ok: boolean } & T;
      return body as { ok: boolean } & T;
    } catch {
      throw new ConnectError("majhi could not reach Slack. Check the connection and try again.", "network");
    }
  }

  private async saveSlack(input: SaveInput, meta: CommandMeta): Promise<SaveResult> {
    const bot = checkSlackToken("bot", input.values.botToken ?? "");
    const app = checkSlackToken("app", input.values.appToken ?? "");
    const who = await this.slack<{ team?: string; user?: string }>("auth.test", bot);
    if (!who.ok)
      throw new ConnectError(
        "Slack did not accept the bot token. Copy it again from OAuth & Permissions.",
        "refused",
      );
    const open = await this.slack("apps.connections.open", app);
    if (!open.ok) {
      throw new ConnectError(
        "Slack did not accept the app-level token. Check that it has the permission connections:write and that Socket Mode is on.",
        "refused",
      );
    }
    const account = [who.team, who.user].filter((v): v is string => typeof v === "string").join(" / ");
    const connection = await this.upsert(
      input,
      meta,
      "slack",
      "Slack",
      {
        SLACK_BOT_TOKEN: { kind: "secret" },
        SLACK_APP_TOKEN: { kind: "secret" },
      },
      account,
      "chat",
    );
    await this.deps.connections.setSecret?.(
      { id: connection, field: "SLACK_BOT_TOKEN", list: "vars", value: bot },
      "connect.appSave",
      meta,
    );
    await this.deps.connections.setSecret?.(
      { id: connection, field: "SLACK_APP_TOKEN", list: "vars", value: app },
      "connect.appSave",
      meta,
    );
    this.deps.observe?.(connection, {
      ok: true,
      detail: `Slack: ${account === "" ? "the app" : account}.`,
      warnings: [],
      at: new Date().toISOString(),
      durationMs: 0,
      checked: ["Asked Slack which workspace the app is in (auth.test)", "Opened a Socket Mode connection"],
      account,
    });
    this.deps.changed();
    this.deps.log?.(`connect: slack connected in ${input.org}`);
    return {
      app: "slack",
      connection,
      message: `Slack is connected${account === "" ? "" : ` as ${account}`}. Add the app to each client channel. The channels show up under New chats.`,
    };
  }

  private async saveDiscord(input: SaveInput, meta: CommandMeta): Promise<SaveResult> {
    const id = checkDiscordId(input.values.applicationId ?? "");
    const token = (input.values.botToken ?? "").trim();
    if (token.length < 30 || /\s/.test(token)) {
      throw new ConnectError(
        "The bot token looks wrong. On the Bot page press Reset Token and copy the new one.",
        "protocol",
      );
    }
    const me = await this.discordMe(token);
    if (me === undefined)
      throw new ConnectError(
        "Discord did not accept the bot token. Reset it on the Bot page and copy it again.",
        "refused",
      );
    if (me.id !== id) {
      throw new ConnectError(
        "That bot token belongs to a different application than the ID you gave.",
        "protocol",
      );
    }
    const connection = await this.upsert(
      input,
      meta,
      "discord",
      "Discord",
      {
        DISCORD_BOT_TOKEN: { kind: "secret" },
        DISCORD_APPLICATION_ID: { kind: "text", value: id },
      },
      me.name,
    );
    await this.deps.connections.setSecret?.(
      { id: connection, field: "DISCORD_BOT_TOKEN", list: "vars", value: token },
      "connect.appSave",
      meta,
    );
    this.deps.changed();
    this.deps.log?.(`connect: discord connected in ${input.org}`);
    return {
      app: "discord",
      connection,
      message: `Discord is connected as ${me.name}. Add the bot to your server with the link below.`,
      next: { label: "Add the bot to your server", url: discordAddBotUrl(id, input.access) },
    };
  }

  /** Asks Telegram who a bot token belongs to. Never puts the token in a message. */
  private async telegramMe(token: string): Promise<{ id: number; username: string } | undefined> {
    try {
      const base = (this.deps.telegramApi ?? TELEGRAM).replace(/\/+$/, "");
      const res = await this.deps.fetch()(`${base}/bot${token}/getMe`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      const body = z
        .object({
          ok: z.boolean(),
          result: z.object({ id: z.number(), username: z.string().optional() }).optional(),
        })
        .safeParse(await res.json().catch(() => undefined));
      if (!body.success || !body.data.ok || body.data.result === undefined) return undefined;
      return { id: body.data.result.id, username: body.data.result.username ?? String(body.data.result.id) };
    } catch {
      throw new ConnectError(
        "majhi could not reach Telegram. Check the connection and try again.",
        "network",
      );
    }
  }

  private async saveTelegram(input: SaveInput, meta: CommandMeta): Promise<SaveResult> {
    const token = checkTelegramToken(input.values.botToken ?? "");
    const me = await this.telegramMe(token);
    if (me === undefined) {
      throw new ConnectError(
        "Telegram did not accept the bot token. Copy it again from BotFather.",
        "refused",
      );
    }
    const account = `@${me.username}`;
    const connection = await this.upsert(
      input,
      meta,
      "telegram",
      "Telegram",
      { TELEGRAM_BOT_TOKEN: { kind: "secret" } },
      account,
      "chat",
    );
    await this.deps.connections.setSecret?.(
      { id: connection, field: "TELEGRAM_BOT_TOKEN", list: "vars", value: token },
      "connect.appSave",
      meta,
    );
    this.deps.observe?.(connection, {
      ok: true,
      detail: `Telegram: bot ${account}.`,
      warnings: [],
      at: new Date().toISOString(),
      durationMs: 0,
      checked: ["Asked Telegram who the bot is (getMe)"],
      account,
    });
    this.deps.changed();
    this.deps.log?.(`connect: telegram connected in ${input.org}`);
    return {
      app: "telegram",
      connection,
      message: `Telegram is connected as ${account}. Add the bot to each client group as an admin. The groups show up under New chats.`,
    };
  }

  private async discordMe(token: string): Promise<{ id: string; name: string } | undefined> {
    try {
      const res = await this.deps.fetch()(`${DISCORD}/users/@me`, {
        headers: { authorization: `Bot ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return undefined;
      }
      const body = z.object({ id: z.string(), username: z.string() }).safeParse(await res.json());
      return body.success ? { id: body.data.id, name: body.data.username } : undefined;
    } catch {
      throw new ConnectError("majhi could not reach Discord. Check the connection and try again.", "network");
    }
  }

  /** The workspace's one connection for this service: made now, or kept and given the new tokens. */
  private async upsert(
    input: SaveInput,
    meta: CommandMeta,
    service: string,
    name: string,
    vars: Record<string, { kind: "secret" | "text"; value?: string }>,
    account: string,
    type: "env" | "chat" = "env",
  ): Promise<string> {
    const all = await this.deps.connectionIds();
    const had = all.find((c) => c.org === input.org && c.connection.fields?.service === service);
    if (had !== undefined) return had.id;
    const id = suggestConnectionId(service, new Set(all.map((c) => c.id)));
    await this.deps.connections.create(
      {
        org: input.org,
        id,
        type,
        name,
        description:
          type === "chat"
            ? `${name} bot for this workspace's client chats. Only majhi reads it.`
            : `${name} bot for this workspace. Variables ${Object.keys(vars).join(", ")}. Posting asks the owner first.`,
        fields: {
          service,
          ...(type === "env" ? { access: input.access === "read" ? "read" : "readwrite" } : {}),
          ...(account === "" ? {} : { account }),
        },
        vars,
      },
      "connect.appSave",
      meta,
    );
    return id;
  }

  /** The Test of a Slack or Discord connection. */
  async test(connection: string, service: string): Promise<ConnectionTestResult> {
    const started = Date.now();
    const result = (
      ok: boolean,
      detail: string,
      more: { failure?: ConnectionFailure; checked?: string[]; account?: string } = {},
    ): ConnectionTestResult => ({
      ok,
      detail,
      warnings: [],
      at: new Date().toISOString(),
      durationMs: Date.now() - started,
      ...more,
    });
    try {
      if (service === "slack") {
        const token = await this.deps.secretOf(connection, "SLACK_BOT_TOKEN");
        if (token === undefined) {
          return result(false, "The bot token is not saved. Set the app up again.", {
            failure: { reason: "no-credential" },
          });
        }
        const who = await this.slack<{ team?: string; user?: string }>("auth.test", token);
        // Slack answers 200 with `ok: false`: that field is the status.
        return who.ok
          ? result(true, `Slack: ${who.team ?? "workspace"} as ${who.user ?? "the app"}.`, {
              checked: ["Asked Slack which workspace the app is in (auth.test)"],
              account: [who.team, who.user].filter((v): v is string => typeof v === "string").join(" / "),
            })
          : result(false, "Slack no longer accepts the bot token. Set the app up again.", {
              failure: { reason: "rejected" },
            });
      }
      if (service === "telegram") {
        const token = await this.deps.secretOf(connection, "TELEGRAM_BOT_TOKEN");
        if (token === undefined) {
          return result(false, "The bot token is not saved. Set the app up again.", {
            failure: { reason: "no-credential" },
          });
        }
        const me = await this.telegramMe(token);
        return me === undefined
          ? result(
              false,
              "Telegram no longer accepts the bot token. Make a new one in BotFather and set the app up again.",
              {
                failure: { reason: "rejected" },
              },
            )
          : result(true, `Telegram: bot @${me.username}.`, {
              checked: ["Asked Telegram who the bot is (getMe)"],
              account: `@${me.username}`,
            });
      }
      if (service === "discord") {
        const token = await this.deps.secretOf(connection, "DISCORD_BOT_TOKEN");
        if (token === undefined) {
          return result(false, "The bot token is not saved. Set the app up again.", {
            failure: { reason: "no-credential" },
          });
        }
        const me = await this.discordMe(token);
        return me === undefined
          ? result(false, "Discord no longer accepts the bot token. Reset it and set the app up again.", {
              failure: { reason: "rejected" },
            })
          : result(true, `Discord: bot ${me.name}.`, {
              checked: ["Asked Discord who the bot is (users/@me)"],
              account: me.name,
            });
      }
    } catch (err) {
      if (err instanceof ConnectError) {
        return result(false, err.message, {
          failure: { reason: err.kind === "network" ? "unreachable" : "unexpected" },
        });
      }
      throw err;
    }
    return result(false, "That service has no test.", { failure: { reason: "unexpected" } });
  }

  /** Asks Slack to end the app's bot token. Discord has no such call. */
  async revoke(connection: string, service: string): Promise<boolean> {
    if (service !== "slack") return false;
    const token = await this.deps.secretOf(connection, "SLACK_BOT_TOKEN");
    if (token === undefined) return false;
    try {
      return (await this.slack("auth.revoke", token)).ok;
    } catch {
      return false;
    }
  }
}
