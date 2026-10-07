// biome-ignore-all lint/suspicious/noExplicitAny: a proof script reading untyped JSON from the API
/**
 * The throwaway majhi the incident walkthrough drives (port 7490). It is e2e/start-server.ts with a seeded home: workspace
 * Acme with a project `storefront` whose remote is the fake GitLab (7492), a signed-in team with a captain, and a chat
 * connection to the fake Slack (7491). Nothing here reaches a real host. Run from the repository root:
 *
 *   MAJHI_E2E_PORT=7490 node --import tsx e2e/incident-walk/server.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { generateKey, SecretStore } from "../../apps/server/src/secrets/store.ts";
import { fakeAdapter, fakeUsage } from "../../packages/acp/testing/index.ts";
import { seedHome } from "../home-seed.ts";
import { E2E_PORT, E2E_ROOT, HOST_HOME, MAJHI_HOME, OFFLINE_FILE, SECRETS_KEY_FILE } from "../paths.ts";

const { parse, stringify } = createRequire(new URL("../../apps/server/package.json", import.meta.url))(
  "yaml",
) as typeof import("yaml");
const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "owner",
  GIT_AUTHOR_EMAIL: "owner@acme.example",
  GIT_COMMITTER_NAME: "owner",
  GIT_COMMITTER_EMAIL: "owner@acme.example",
  GIT_SSH_COMMAND: "false",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: { ...process.env, ...gitEnv }, stdio: "pipe" });

const GITLAB = process.env.WALK_GITLAB ?? "127.0.0.1:7492";
const SLACK_API = process.env.WALK_SLACK_API ?? "http://127.0.0.1:7491/api";

rmSync(E2E_ROOT, { recursive: true, force: true });
const repo = join(HOST_HOME, "Work", "storefront");
mkdirSync(repo, { recursive: true });
git(repo, "init", "--quiet", "--initial-branch", "main");
writeFileSync(join(repo, "orders.txt"), "slow query: select * from orders\n");
git(repo, "add", ".");
git(repo, "commit", "--quiet", "--message", "init");
git(repo, "remote", "add", "origin", `http://${GITLAB}/acme/storefront.git`);
mkdirSync(MAJHI_HOME, { recursive: true });
mkdirSync(dirname(SECRETS_KEY_FILE), { recursive: true });
writeFileSync(SECRETS_KEY_FILE, `${await generateKey()}\n`, { mode: 0o600 });
await seedHome("team");

const file = join(MAJHI_HOME, "majhi.yaml");
const config = parse(readFileSync(file, "utf8")) as Record<string, any>;
config.orgs.acme = {
  ...config.orgs.acme,
  git_accounts: [{ host: "127.0.0.1", account: "owner", token: "secret:gl-token" }],
  connections: {
    slack: {
      type: "chat",
      name: "Slack",
      fields: { service: "slack", account: "Acme Team / majhi" },
      vars: {
        SLACK_BOT_TOKEN: { kind: "secret", value: "secret:slack-bot" },
        SLACK_APP_TOKEN: { kind: "secret", value: "secret:slack-app" },
      },
    },
  },
};
config.projects = { storefront: { org: "acme", path: "~/Work/storefront", base: "main" } };
writeFileSync(file, stringify(config));
const secrets = new SecretStore(MAJHI_HOME, SECRETS_KEY_FILE);
await secrets.set("gl-token", "gl-fake-token-2222");
await secrets.set("slack-bot", "xoxb-000000000000-fake-token-aaaaaaaaaaaaaaaaaaaa");
await secrets.set("slack-app", "xapp-1-A000000-fake-token-aaaaaaaaaaaaaaaaaaaaaaaa");

const fakes = {
  models: ["fake-model-a", "fake-model-b", "fake-model-c"],
  efforts: ["low", "medium", "high"],
  usage: { fiveHourPct: 42, weekPct: 18, opusPct: 30, plan: "max" },
};
const command = (tool: "claude" | "codex") => {
  const { command, args } = fakeAdapter(tool, {
    ...fakes,
    slowMs: 0,
    ...(process.env.WALK_REPLIES === undefined ? {} : { replies: process.env.WALK_REPLIES }),
  });
  return JSON.stringify([command, ...args]);
};
Object.assign(process.env, gitEnv, {
  MAJHI_HOST: "127.0.0.1",
  MAJHI_PORT: String(E2E_PORT),
  HOST_HOME,
  MAJHI_HOME,
  MAJHI_VERSION: "walk",
  MAJHI_RUNNER: "local",
  MAJHI_CHATS: "on",
  MAJHI_SLACK_API: SLACK_API,
  MAJHI_SECRETS_KEY_FILE: SECRETS_KEY_FILE,
  MAJHI_ADAPTER_CLAUDE: command("claude"),
  MAJHI_ADAPTER_CODEX: command("codex"),
  MAJHI_USAGE_CLAUDE: JSON.stringify([fakeUsage(fakes).command, ...fakeUsage(fakes).args]),
  MAJHI_NET_PROBE: `file:${OFFLINE_FILE}`,
  MAJHI_NET_PROBE_MS: "500",
});
// majhi drops a port from a git host (a self-hosted GitLab is reached on its host name), so the fake GitLab on 7492 is
// reached through this one rewrite of the throwaway server's own fetch. Nothing else changes.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const text = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (text.startsWith("http://127.0.0.1/api/v4")) {
    return realFetch(text.replace("http://127.0.0.1/", `http://${GITLAB}/`), init);
  }
  return realFetch(input, init);
}) as typeof fetch;
await import("../../apps/server/src/main.ts");
