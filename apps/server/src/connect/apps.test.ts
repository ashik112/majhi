import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  buildAppSetup,
  type CommandMeta,
  type ConnectionConfig,
  discordAddBotUrl,
  scopesAt,
  SERVICE_CATALOG,
  slackManifest,
} from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { generateKey, SecretStore } from "../secrets/store.ts";
import { tempDir, writeKeyFile } from "../testing/fixtures.ts";
import { AppClientStore, parseGoogleClientJson } from "./app-client.ts";
import { AppService } from "./app-service.ts";

const OWNER: CommandMeta = { actor: { kind: "owner" } };
const REDIRECT = "http://127.0.0.1:7070/oauth/callback";

const desktopClient = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    installed: {
      client_id: "1234-abc.apps.googleusercontent.com",
      client_secret: "GOCSPX-fake-secret-value-1",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      redirect_uris: ["http://localhost"],
      ...extra,
    },
  });

describe("Google's client file", () => {
  it("takes a Desktop client", () => {
    expect(parseGoogleClientJson(desktopClient())).toEqual({
      clientId: "1234-abc.apps.googleusercontent.com",
      clientSecret: "GOCSPX-fake-secret-value-1",
    });
  });

  it("refuses text that is not JSON, and JSON that is not a client", () => {
    expect(() => parseGoogleClientJson("{ not json")).toThrow(/not a Google client file/);
    expect(() => parseGoogleClientJson("[]")).toThrow(/not a Google client file/);
    expect(() => parseGoogleClientJson('{"installed":{"client_id":"x"}}')).toThrow(/not a Google client file/);
    expect(() => parseGoogleClientJson(desktopClient({ client_id: "plain-id" }))).toThrow(/not a Google client file/);
  });

  it("explains a Web client and asks for a Desktop one", () => {
    const web = JSON.stringify({
      web: { client_id: "1-a.apps.googleusercontent.com", client_secret: "s", redirect_uris: ["https://acme.example/cb"] },
    });
    expect(() => parseGoogleClientJson(web)).toThrow(/Web client.*Desktop app/);
  });

  it("refuses a file that points the token endpoint somewhere else", () => {
    expect(() => parseGoogleClientJson(desktopClient({ token_uri: "https://evil.example/token" }))).toThrow(
      /somewhere other than Google/,
    );
    expect(() => parseGoogleClientJson(desktopClient({ token_uri: "http://oauth2.googleapis.com/token" }))).toThrow(
      /somewhere other than Google/,
    );
    expect(() => parseGoogleClientJson(desktopClient({ auth_uri: "not a url" }))).toThrow(/not a Google client file/);
  });
});

describe("the Slack manifest", () => {
  it("round-trips through the deep link and holds exactly the pack's scopes", () => {
    const view = buildAppSetup("slack", { orgName: "Acme", redirect: REDIRECT, access: "read" });
    const manifest = view?.manifest;
    expect(manifest).toBeDefined();
    const fromLink = new URL(manifest?.createUrl ?? "").searchParams.get("manifest_json");
    expect(fromLink).toBe(manifest?.json);
    const parsed = JSON.parse(manifest?.json ?? "{}");
    expect(parsed).toEqual(JSON.parse(JSON.stringify(slackManifest("majhi (Acme)", "read"))));
    expect(parsed.display_information.name).toBe("majhi (Acme)");
    expect(parsed.settings.socket_mode_enabled).toBe(true);
    expect(parsed.oauth_config.scopes.bot).toContain("channels:history");
    expect(parsed.oauth_config.scopes.bot).not.toContain("chat:write");
    // The create link opens Slack's own page.
    expect(manifest?.createUrl.startsWith("https://api.slack.com/apps?new_app=1&manifest_json=")).toBe(true);
  });

  it("adds posting only at readwrite, and is the same every time", () => {
    const write = buildAppSetup("slack", { orgName: "Acme", redirect: REDIRECT, access: "readwrite" });
    expect(JSON.parse(write?.manifest?.json ?? "{}").oauth_config.scopes.bot).toContain("chat:write");
    const again = buildAppSetup("slack", { orgName: "Acme", redirect: REDIRECT, access: "readwrite" });
    expect(again?.manifest?.json).toBe(write?.manifest?.json);
  });
});

describe("the sheets", () => {
  it("every app names the redirect address and the app name, and no sheet holds a secret", () => {
    for (const app of ["google", "linkedin", "linear", "microsoft", "x", "github"]) {
      const view = buildAppSetup(app, { orgName: "Acme", redirect: REDIRECT, access: "read" });
      const text = JSON.stringify(view);
      expect(view?.appName).toBe("majhi (Acme)");
      expect(text).toContain("7070/oauth/callback");
      expect(view?.steps.length).toBeGreaterThanOrEqual(2);
    }
    // Microsoft takes localhost for the loopback address.
    const ms = JSON.stringify(buildAppSetup("microsoft", { orgName: "Acme", redirect: REDIRECT, access: "read" }));
    expect(ms).toContain("http://localhost:7070/oauth/callback");
  });

  it("lists what the app may do in plain words and grows with the access", () => {
    const read = buildAppSetup("google", { orgName: "Acme", redirect: REDIRECT, access: "read" });
    const send = buildAppSetup("google", { orgName: "Acme", redirect: REDIRECT, access: "send" });
    expect(read?.scopes.every((s) => s.access === "read")).toBe(true);
    expect(send?.scopes.some((s) => /Send mail/.test(s.sentence))).toBe(true);
    expect((send?.scopes.length ?? 0) > (read?.scopes.length ?? 0)).toBe(true);
  });

  it("read access never includes a write or send scope, and readwrite never sends", () => {
    for (const entry of SERVICE_CATALOG) {
      expect(scopesAt(entry, "read").every((s) => s.access === "read")).toBe(true);
      expect(scopesAt(entry, "readwrite").every((s) => s.level !== "send")).toBe(true);
    }
  });

  it("every catalog entry that needs an app has a sheet", () => {
    for (const entry of SERVICE_CATALOG) {
      if (entry.app !== undefined) {
        expect(buildAppSetup(entry.app, { orgName: "Acme", redirect: REDIRECT, access: "read" })).toBeDefined();
      }
    }
  });
});

describe("saving an app", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
  });

  async function rig(
    handler: (url: string, init: RequestInit) => { status?: number; body: unknown } = () => ({ body: { ok: true } }),
  ) {
    const made = await tempDir();
    cleanup = made.cleanup;
    const keyFile = join(made.dir, "secrets.key");
    await writeKeyFile(keyFile, await generateKey());
    await mkdir(join(made.dir, "home"));
    const secrets = new SecretStore(join(made.dir, "home"), keyFile);
    const apps = new AppClientStore(secrets);
    const calls: { url: string; auth: string }[] = [];
    const connections = new Map<string, { org: string; connection: ConnectionConfig }>();
    const setSecrets: { id: string; field: string }[] = [];
    const stored = new Map<string, string>();
    const logs: string[] = [];
    const service = new AppService({
      apps,
      orgName: async (org) => (org === "acme" ? "Acme" : undefined),
      redirect: REDIRECT,
      fetch: () => async (url, init) => {
        calls.push({ url: String(url), auth: String((init?.headers as Record<string, string>)?.authorization ?? "") });
        const out = handler(String(url), init ?? {});
        return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
      },
      connections: {
        async create(input) {
          connections.set(input.id ?? input.name, {
            org: input.org,
            connection: { type: input.type, name: input.name, fields: input.fields, vars: input.vars } as ConnectionConfig,
          });
        },
        async remove(id) {
          connections.delete(id);
        },
        async find(id) {
          return connections.get(id);
        },
        async setSecret(input) {
          setSecrets.push({ id: input.id, field: input.field });
          stored.set(`${input.id}.${input.field}`, input.value);
        },
      },
      connectionIds: async () => [...connections].map(([id, c]) => ({ id, ...c })),
      secretOf: async (id, name) => stored.get(`${id}.${name}`),
      changed: () => undefined,
      log: (line) => logs.push(line),
    });
    return { service, apps, secrets, calls, connections, setSecrets, stored, logs, dir: made.dir };
  }

  it("keeps a Google client encrypted, per workspace, and shows it nowhere", async () => {
    const t = await rig();
    const out = await t.service.save({ org: "acme", app: "google", values: { clientJson: desktopClient() }, access: "read" }, OWNER);
    expect(out.message).toMatch(/saved/);
    expect(JSON.stringify(out)).not.toContain("GOCSPX");
    expect((await t.apps.get("google", "acme"))?.clientSecret).toBe("GOCSPX-fake-secret-value-1");
    expect(await t.apps.get("google", "globex")).toBeUndefined();
    // Not readable on disk.
    for (const name of await readdir(join(t.dir, "home"), { recursive: true })) {
      const text = await readFile(join(t.dir, "home", name), "utf8").catch(() => "");
      expect(text).not.toContain("GOCSPX-fake-secret-value-1");
    }
    const view = await t.service.view("acme", "google", "read");
    expect(view.saved).toBe(true);
    expect(JSON.stringify(view)).not.toContain("GOCSPX");
    expect(t.logs.join("\n")).not.toContain("GOCSPX");
    expect((await t.service.forget("acme", "google")).removed).toBe(true);
    expect((await t.service.view("acme", "google", "read")).saved).toBe(false);
  });

  it("refuses a bad Google file with a sentence and saves nothing", async () => {
    const t = await rig();
    await expect(
      t.service.save({ org: "acme", app: "google", values: { clientJson: "oops" }, access: "read" }, OWNER),
    ).rejects.toThrow(/not a Google client file/);
    await expect(
      t.service.save({ org: "acme", app: "google", values: { clientJson: JSON.stringify({ web: {} }) }, access: "read" }, OWNER),
    ).rejects.toThrow(/Desktop app/);
    await expect(
      t.service.save({ org: "acme", app: "google", values: {}, access: "read" }, OWNER),
    ).rejects.toThrow(/Drop the client file/);
    expect(await t.apps.get("google", "acme")).toBeUndefined();
  });

  it("saves a client ID and secret for LinkedIn and refuses empty or spaced values", async () => {
    const t = await rig();
    await expect(
      t.service.save({ org: "acme", app: "linkedin", values: { clientId: "abc def" }, access: "read" }, OWNER),
    ).rejects.toThrow();
    await expect(
      t.service.save({ org: "acme", app: "linkedin", values: { clientId: "78abcdef12" }, access: "read" }, OWNER),
    ).rejects.toThrow(/secret is empty/);
    await t.service.save({ org: "acme", app: "linkedin", values: { clientId: "78abcdef12", clientSecret: "wpl-secret-value" }, access: "read" }, OWNER);
    expect(await t.apps.get("linkedin", "acme")).toMatchObject({ clientId: "78abcdef12", clientSecret: "wpl-secret-value" });
  });

  it("refuses an unknown workspace and an unknown app", async () => {
    const t = await rig();
    await expect(t.service.save({ org: "nope", app: "x", values: { clientId: "abcdef12" }, access: "read" }, OWNER)).rejects.toThrow(/does not exist/);
    await expect(t.service.save({ org: "acme", app: "nope", values: {}, access: "read" }, OWNER)).rejects.toThrow(/no app setup/);
  });

  it("connects Slack with two checked tokens, stores them as secrets and never logs them", async () => {
    const t = await rig((url) =>
      url.endsWith("auth.test") ? { body: { ok: true, team: "Acme Team", user: "majhi" } } : { body: { ok: true, url: "wss://x" } },
    );
    const out = await t.service.save(
      { org: "acme", app: "slack", values: { botToken: "xoxb-1111-2222-fakebottokenvalue", appToken: "xapp-1-A-2-fakeapptokenvalue" }, access: "read" },
      OWNER,
    );
    expect(out.connection).toBeDefined();
    expect(JSON.stringify(out)).not.toContain("xoxb-1111");
    const made = t.connections.get(out.connection ?? "");
    expect(made?.connection.type).toBe("env");
    expect(made?.connection.fields).toMatchObject({ service: "slack", account: "Acme Team / majhi", access: "read" });
    expect(Object.keys(made?.connection.vars ?? {}).sort()).toEqual(["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
    // The secret entries are created empty; the values go through setSecret only.
    expect(JSON.stringify(made?.connection.vars)).not.toContain("xoxb");
    expect(t.setSecrets.map((s) => s.field).sort()).toEqual(["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
    expect(t.logs.join("\n")).not.toContain("xoxb");
    expect(t.logs.join("\n")).not.toContain("xapp");
    // Saving again keeps the one connection.
    await t.service.save(
      { org: "acme", app: "slack", values: { botToken: "xoxb-3333-4444-anotherbottokenvalue", appToken: "xapp-1-A-2-fakeapptokenvalue" }, access: "read" },
      OWNER,
    );
    expect(t.connections.size).toBe(1);
    expect((await t.service.status("acme")).find((s) => s.app === "slack")?.saved).toBe(true);
  });

  it("refuses Slack tokens of the wrong kind or that Slack does not accept", async () => {
    const t = await rig(() => ({ body: { ok: false, error: "invalid_auth" } }));
    await expect(
      t.service.save({ org: "acme", app: "slack", values: { botToken: "xapp-1-A-2-wrongkindoftokenvalue", appToken: "xapp-1-A-2-fakeapptokenvalue" }, access: "read" }, OWNER),
    ).rejects.toThrow(/starts with xoxb-/);
    await expect(
      t.service.save({ org: "acme", app: "slack", values: { botToken: "xoxb-1111-2222-fakebottokenvalue", appToken: "xoxb-1-A-2-wrongkindoftokenvalue" }, access: "read" }, OWNER),
    ).rejects.toThrow(/starts with xapp-/);
    await expect(
      t.service.save({ org: "acme", app: "slack", values: { botToken: "xoxb-1111-2222-fakebottokenvalue", appToken: "xapp-1-A-2-fakeapptokenvalue" }, access: "read" }, OWNER),
    ).rejects.toThrow(/did not accept the bot token/);
    expect(t.connections.size).toBe(0);
  });

  it("revokes Slack's bot token on request and tests with it", async () => {
    const t = await rig((url) => ({ body: url.endsWith("auth.test") ? { ok: true, team: "Acme Team", user: "majhi" } : { ok: true } }));
    const out = await t.service.save(
      { org: "acme", app: "slack", values: { botToken: "xoxb-1111-2222-fakebottokenvalue", appToken: "xapp-1-A-2-fakeapptokenvalue" }, access: "read" },
      OWNER,
    );
    const id = out.connection ?? "";
    expect((await t.service.test(id, "slack")).ok).toBe(true);
    expect(await t.service.revoke(id, "slack")).toBe(true);
    expect(t.calls.at(-1)?.url).toMatch(/auth\.revoke$/);
    expect(t.calls.at(-1)?.auth).toBe("Bearer xoxb-1111-2222-fakebottokenvalue");
    expect(await t.service.revoke(id, "discord")).toBe(false);
  });

  it("connects Discord with a checked bot and gives the add-to-server link for the access", async () => {
    const t = await rig(() => ({ body: { id: "123456789012345678", username: "majhi-bot" } }));
    const out = await t.service.save(
      { org: "acme", app: "discord", values: { applicationId: "123456789012345678", botToken: "MTIzNDU2.fake.discordbottokenvalue12345" }, access: "read" },
      OWNER,
    );
    expect(out.next?.url).toBe(discordAddBotUrl("123456789012345678", "read"));
    expect(out.next?.url).toContain("permissions=66560");
    expect(discordAddBotUrl("123456789012345678", "readwrite")).toContain("permissions=68608");
    expect(t.calls[0]?.auth).toBe("Bot MTIzNDU2.fake.discordbottokenvalue12345");
    expect(JSON.stringify(out)).not.toContain("discordbottokenvalue");
    expect(t.logs.join("\n")).not.toContain("discordbottokenvalue");
    expect(t.stored.get(`${out.connection}.DISCORD_BOT_TOKEN`)).toBe("MTIzNDU2.fake.discordbottokenvalue12345");
  });

  it("refuses a Discord token that belongs to another application", async () => {
    const t = await rig(() => ({ body: { id: "999999999999999999", username: "other-bot" } }));
    await expect(
      t.service.save(
        { org: "acme", app: "discord", values: { applicationId: "123456789012345678", botToken: "MTIzNDU2.fake.discordbottokenvalue12345" }, access: "read" },
        OWNER,
      ),
    ).rejects.toThrow(/different application/);
    expect(t.connections.size).toBe(0);
    await expect(
      t.service.save({ org: "acme", app: "discord", values: { applicationId: "12", botToken: "x".repeat(40) }, access: "read" }, OWNER),
    ).rejects.toThrow(/17 to 20 digits/);
  });

  it("says Discord refused a token it answers 401 to", async () => {
    const t = await rig(() => ({ status: 401, body: { message: "401: Unauthorized" } }));
    await expect(
      t.service.save(
        { org: "acme", app: "discord", values: { applicationId: "123456789012345678", botToken: "MTIzNDU2.fake.discordbottokenvalue12345" }, access: "read" },
        OWNER,
      ),
    ).rejects.toThrow(/did not accept the bot token/);
  });
});
