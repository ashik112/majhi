import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type CommandMeta, type ConnectionConfig, SERVICE_CATALOG, scopesAt } from "@majhi/shared";
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
  it("refuses a file that points the token endpoint somewhere else", () => {
    expect(() => parseGoogleClientJson(desktopClient({ token_uri: "https://evil.example/token" }))).toThrow(
      /somewhere other than Google/,
    );
    expect(() =>
      parseGoogleClientJson(desktopClient({ token_uri: "http://oauth2.googleapis.com/token" })),
    ).toThrow(/somewhere other than Google/);
    expect(() => parseGoogleClientJson(desktopClient({ auth_uri: "not a url" }))).toThrow(
      /not a Google client file/,
    );
  });
});

describe("the sheets", () => {
  it("read access never includes a write or send scope, and readwrite never sends", () => {
    for (const entry of SERVICE_CATALOG) {
      expect(scopesAt(entry, "read").every((s) => s.access === "read")).toBe(true);
      expect(scopesAt(entry, "readwrite").every((s) => s.level !== "send")).toBe(true);
    }
  });
});

describe("saving an app", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
  });

  async function rig(
    handler: (url: string, init: RequestInit) => { status?: number; body: unknown } = () => ({
      body: { ok: true },
    }),
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
        calls.push({
          url: String(url),
          auth: String((init?.headers as Record<string, string>)?.authorization ?? ""),
        });
        const out = handler(String(url), init ?? {});
        return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
      },
      connections: {
        async create(input) {
          connections.set(input.id ?? input.name, {
            org: input.org,
            connection: {
              type: input.type,
              name: input.name,
              fields: input.fields,
              vars: input.vars,
            } as ConnectionConfig,
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
    const out = await t.service.save(
      { org: "acme", app: "google", values: { clientJson: desktopClient() }, access: "read" },
      OWNER,
    );
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

  it("connects Slack with two checked tokens, stores them as secrets and never logs them", async () => {
    const t = await rig((url) =>
      url.endsWith("auth.test")
        ? { body: { ok: true, team: "Acme Team", user: "majhi" } }
        : { body: { ok: true, url: "wss://x" } },
    );
    const out = await t.service.save(
      {
        org: "acme",
        app: "slack",
        values: { botToken: "xoxb-1111-2222-fakebottokenvalue", appToken: "xapp-1-A-2-fakeapptokenvalue" },
        access: "read",
      },
      OWNER,
    );
    expect(out.connection).toBeDefined();
    expect(JSON.stringify(out)).not.toContain("xoxb-1111");
    const made = t.connections.get(out.connection ?? "");
    expect(made?.connection.type).toBe("env");
    expect(made?.connection.fields).toMatchObject({
      service: "slack",
      account: "Acme Team / majhi",
      access: "read",
    });
    expect(Object.keys(made?.connection.vars ?? {}).sort()).toEqual(["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
    // The secret entries are created empty; the values go through setSecret only.
    expect(JSON.stringify(made?.connection.vars)).not.toContain("xoxb");
    expect(t.setSecrets.map((s) => s.field).sort()).toEqual(["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
    expect(t.logs.join("\n")).not.toContain("xoxb");
    expect(t.logs.join("\n")).not.toContain("xapp");
    // Saving again keeps the one connection.
    await t.service.save(
      {
        org: "acme",
        app: "slack",
        values: { botToken: "xoxb-3333-4444-anotherbottokenvalue", appToken: "xapp-1-A-2-fakeapptokenvalue" },
        access: "read",
      },
      OWNER,
    );
    expect(t.connections.size).toBe(1);
    expect((await t.service.status("acme")).find((s) => s.app === "slack")?.saved).toBe(true);
  });

  it("refuses Slack tokens of the wrong kind or that Slack does not accept", async () => {
    const t = await rig(() => ({ body: { ok: false, error: "invalid_auth" } }));
    await expect(
      t.service.save(
        {
          org: "acme",
          app: "slack",
          values: { botToken: "xapp-1-A-2-wrongkindoftokenvalue", appToken: "xapp-1-A-2-fakeapptokenvalue" },
          access: "read",
        },
        OWNER,
      ),
    ).rejects.toThrow(/starts with xoxb-/);
    await expect(
      t.service.save(
        {
          org: "acme",
          app: "slack",
          values: {
            botToken: "xoxb-1111-2222-fakebottokenvalue",
            appToken: "xoxb-1-A-2-wrongkindoftokenvalue",
          },
          access: "read",
        },
        OWNER,
      ),
    ).rejects.toThrow(/starts with xapp-/);
    await expect(
      t.service.save(
        {
          org: "acme",
          app: "slack",
          values: { botToken: "xoxb-1111-2222-fakebottokenvalue", appToken: "xapp-1-A-2-fakeapptokenvalue" },
          access: "read",
        },
        OWNER,
      ),
    ).rejects.toThrow(/did not accept the bot token/);
    expect(t.connections.size).toBe(0);
  });

  it("refuses a Discord token that belongs to another application", async () => {
    const t = await rig(() => ({ body: { id: "999999999999999999", username: "other-bot" } }));
    await expect(
      t.service.save(
        {
          org: "acme",
          app: "discord",
          values: {
            applicationId: "123456789012345678",
            botToken: "MTIzNDU2.fake.discordbottokenvalue12345",
          },
          access: "read",
        },
        OWNER,
      ),
    ).rejects.toThrow(/different application/);
    expect(t.connections.size).toBe(0);
    await expect(
      t.service.save(
        {
          org: "acme",
          app: "discord",
          values: { applicationId: "12", botToken: "x".repeat(40) },
          access: "read",
        },
        OWNER,
      ),
    ).rejects.toThrow(/17 to 20 digits/);
  });
});
