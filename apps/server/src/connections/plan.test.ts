import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConnectionConfig } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { tempDir } from "../testing/fixtures.ts";
import type { HeldConnection } from "./access.ts";
import { planConnections } from "./plan.ts";

const KUBECONFIG = (name: string, token: string) => `apiVersion: v1
kind: Config
clusters: [{ name: c, cluster: { server: "https://${name}.acme.example" } }]
contexts: [{ name: ${name}, context: { cluster: c, user: u } }]
users: [{ name: u, user: { token: ${token} } }]
`;

const SECRETS: Record<string, string> = {
  "acme-newrelic-api-key": "NRAK-0123456789abcdef",
  "acme-mail-password": "app-password-0123456789",
  "acme-keys-api-key": "sk-acme-0123456789",
};

describe("planConnections", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  const connectionDir = (id: string) => join(dir, "connections", id);
  const held = (id: string, connection: ConnectionConfig, org = "acme"): HeldConnection => ({
    id,
    org,
    connection,
  });

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    for (const [id, name, token] of [
      ["acme-prod", "prod", "prod-token-0123456789"],
      ["acme-staging", "staging", "staging-token-0123456789"],
    ] as const) {
      await mkdir(connectionDir(id), { recursive: true });
      await writeFile(join(connectionDir(id), "kubeconfig"), KUBECONFIG(name, token));
    }
    await mkdir(connectionDir("acme-keys"), { recursive: true });
    await writeFile(
      join(connectionDir("acme-keys"), "vars-GOOGLE_APPLICATION_CREDENTIALS"),
      '{"type":"service_account"}',
    );
  });
  afterEach(() => cleanup());

  it("turns each type into what the run gets", async () => {
    const run = join(dir, "run");
    const plan = await planConnections(
      [
        held("acme-prod", {
          type: "kubectl",
          name: "Prod",
          fields: { kubeconfig: "file:kubeconfig", context: "prod", namespace: "api" },
        }),
        held("acme-staging", {
          type: "kubectl",
          name: "Staging",
          fields: { kubeconfig: "file:kubeconfig", context: "staging" },
        }),
        held("acme-keys", {
          type: "env",
          name: "Keys",
          fields: { clis: "aws gcloud" },
          vars: {
            API_KEY: { kind: "secret", value: "secret:acme-keys-api-key" },
            REGION: { kind: "text", value: "eu-west-1" },
            GOOGLE_APPLICATION_CREDENTIALS: {
              kind: "file",
              value: "file:vars-GOOGLE_APPLICATION_CREDENTIALS",
            },
          },
        }),
        held("acme-mail", {
          type: "mail",
          name: "Mail",
          fields: {
            imap_host: "imap.acme.example",
            user: "ops@acme.example",
            password: "secret:acme-mail-password",
          },
        }),
        held("acme-newrelic", {
          type: "mcp",
          name: "New Relic",
          description: "APM and logs.",
          fields: { url: "https://mcp.newrelic.com/mcp", read_tools: "execute_nrql_query" },
          headers: { "Api-Key": { kind: "secret", value: "secret:acme-newrelic-api-key" } },
          allow: ["mute_alert"],
        }),
        held("acme-web", { type: "browser", name: "Web", fields: { server: "playwright" } }),
        held("acme-box", { type: "ssh", name: "Box", fields: { alias: "acme-box" } }),
      ],
      run,
      { secrets: { get: async (name) => SECRETS[name] }, connectionDir, browsersPath: "/opt/ms-playwright" },
    );

    expect(plan.problems).toEqual([]);
    expect(plan.env).toEqual({
      KUBECONFIG: join(run, "kubeconfig"),
      API_KEY: "sk-acme-0123456789",
      REGION: "eu-west-1",
      GOOGLE_APPLICATION_CREDENTIALS: join(run, "acme-keys-GOOGLE_APPLICATION_CREDENTIALS"),
      MAIL_IMAP_HOST: "imap.acme.example",
      MAIL_IMAP_PORT: "993",
      MAIL_USER: "ops@acme.example",
      MAIL_PASSWORD: "app-password-0123456789",
    });
    const kubeconfig = parse(String(plan.files.find((f) => f.name === "kubeconfig")?.data));
    expect(kubeconfig["current-context"]).toBe("acme-prod");
    expect(kubeconfig.contexts.map((c: { name: string }) => c.name)).toEqual(["acme-prod", "acme-staging"]);
    expect(plan.files.map((f) => f.name)).toEqual(["kubeconfig", "acme-keys-GOOGLE_APPLICATION_CREDENTIALS"]);

    expect(plan.servers).toEqual([
      {
        type: "http",
        name: "acme-newrelic",
        url: "https://mcp.newrelic.com/mcp",
        headers: { "Api-Key": "NRAK-0123456789abcdef" },
      },
      {
        type: "stdio",
        name: "acme-web",
        command: "playwright-mcp",
        args: [
          "--headless",
          "--browser",
          "chromium",
          "--no-sandbox",
          "--user-data-dir",
          join(connectionDir("acme-web"), "profile"),
        ],
        env: { PLAYWRIGHT_BROWSERS_PATH: "/opt/ms-playwright" },
      },
    ]);
    expect(plan.profiles).toEqual([join(connectionDir("acme-web"), "profile")]);

    expect(plan.gate.map((g) => [g.id, g.type])).toEqual([
      ["acme-prod", "kubectl"],
      ["acme-staging", "kubectl"],
      ["acme-keys", "env"],
      ["acme-mail", "mail"],
      ["acme-newrelic", "mcp"],
      ["acme-web", "browser"],
      ["acme-box", "ssh"],
    ]);
    expect(plan.gate.find((g) => g.id === "acme-staging")?.context).toBe("acme-staging");
    expect(plan.gate.find((g) => g.id === "acme-keys")?.clis).toEqual(["aws", "gcloud"]);
    expect(plan.gate.find((g) => g.id === "acme-newrelic")).toMatchObject({
      server: "acme-newrelic",
      readTools: ["execute_nrql_query"],
      allow: ["mute_alert"],
    });
    expect(plan.gate.find((g) => g.id === "acme-web")?.readTools).toContain("browser_snapshot");

    expect(plan.secrets.map((s) => s.name).sort()).toEqual([
      "acme-keys.API_KEY",
      "acme-mail.password",
      "acme-newrelic.Api-Key",
      "acme-prod.kubeconfig",
      "acme-staging.kubeconfig",
    ]);
    expect(plan.uses.find((u) => u.id === "acme-prod")?.use).toBe(
      "kubectl --context acme-prod (the current context), namespace api.",
    );
    expect(plan.uses.find((u) => u.id === "acme-keys")?.use).toBe(
      "Variables API_KEY, REGION, GOOGLE_APPLICATION_CREDENTIALS. For aws, gcloud.",
    );
    // Uses never carry a value.
    expect(JSON.stringify(plan.uses)).not.toMatch(/0123456789/);
  });

  it("gives each picked DigitalOcean product its own server on the one sign-in", async () => {
    const plan = await planConnections(
      [
        held("acme-do", {
          type: "mcp",
          name: "DigitalOcean",
          fields: {
            transport: "remote",
            url: "https://accounts.mcp.digitalocean.com/mcp",
            protocol: "http",
            auth: "oauth",
            products: "doks droplets",
          },
        }),
      ],
      join(dir, "run"),
      {
        secrets: { get: async () => undefined },
        connectionDir,
        oauth: async () => ({ token: "do-token-0123456789" }),
      },
    );
    const auth = { Authorization: "Bearer do-token-0123456789" };
    expect(plan.servers).toEqual([
      {
        type: "http",
        name: "acme-do-droplets",
        url: "https://droplets.mcp.digitalocean.com/mcp",
        headers: auth,
      },
      { type: "http", name: "acme-do-doks", url: "https://doks.mcp.digitalocean.com/mcp", headers: auth },
    ]);
    expect(plan.gate.map((g) => g.server)).toEqual(["acme-do-droplets", "acme-do-doks"]);
    expect(plan.uses.map((u) => u.use)).toEqual([
      "MCP servers acme-do-droplets (Droplets), acme-do-doks (Kubernetes).",
    ]);
  });

  it("gives a git connection the workspace's fresh sign-in as the CLI's variable, or says why not", async () => {
    const asked: string[] = [];
    const plan = await planConnections(
      [
        held("acme-gitlab", { type: "git", name: "GitLab", fields: { provider: "gitlab" } }),
        held("globex-gh", { type: "git", name: "GitHub", fields: { provider: "github" } }, "globex"),
      ],
      join(dir, "run"),
      {
        secrets: { get: async () => undefined },
        connectionDir,
        gitToken: async (org, provider, host) => {
          asked.push(`${org} ${provider} ${host}`);
          return org === "acme"
            ? { token: "glpat-0123456789" }
            : { problem: "globex is not signed in to github.com." };
        },
      },
    );
    expect(asked).toEqual(["acme gitlab gitlab.com", "globex github github.com"]);
    expect(plan.env).toEqual({ GITLAB_TOKEN: "glpat-0123456789", GITLAB_HOST: "gitlab.com" });
    expect(plan.gate).toEqual([{ id: "acme-gitlab", type: "git", allow: [], clis: ["glab"] }]);
    expect(plan.secrets).toEqual([{ name: "acme-gitlab.token", value: "glpat-0123456789" }]);
    expect(plan.problems).toEqual([
      "globex-gh: globex is not signed in to github.com. The run does not get it.",
    ]);
    expect(JSON.stringify(plan.uses)).not.toContain("0123456789");
  });

  it("leaves out what is not set up, and keeps the first of two connections that set a variable", async () => {
    await mkdir(connectionDir("acme-broken"), { recursive: true });
    await writeFile(join(connectionDir("acme-broken"), "kubeconfig"), "not: [yaml");
    const plan = await planConnections(
      [
        held("acme-broken", {
          type: "kubectl",
          name: "Broken",
          fields: { kubeconfig: "file:kubeconfig", context: "prod" },
        }),
        held("acme-empty", { type: "kubectl", name: "Empty", fields: { context: "prod" } }),
        held("acme-a", { type: "env", name: "A", vars: { REGION: { kind: "text", value: "eu-west-1" } } }),
        held("acme-b", { type: "env", name: "B", vars: { REGION: { kind: "text", value: "us-east-1" } } }),
      ],
      join(dir, "run"),
      { secrets: { get: async () => undefined }, connectionDir },
    );
    expect(plan.env).toEqual({ REGION: "eu-west-1" });
    expect(plan.files).toEqual([]);
    expect(plan.problems).toEqual([
      "acme-broken: The kubeconfig is not a YAML map.",
      "acme-empty is not set up, so the run does not get it.",
      "REGION is set by acme-a and acme-b; the run gets acme-a's.",
    ]);
  });
});
