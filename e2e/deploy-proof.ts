/**
 * An isolated majhi for proving deploys without touching anything real. It starts, all on loopback:
 *
 *   - a fake GitHub, GitLab and Vercel (`apps/server/src/deploy/testing/fake-hosts.ts`) that also serves the
 *     health addresses a deploy is checked against;
 *   - an ssh host in a throwaway container (`majhi-proof-ssh`, port 2299) that the production target runs the
 *     owner's command on, reached with a throwaway key;
 *   - majhi itself, in this process, on its own home under the temp folder (`MAJHI_E2E_ROOT`), with the team
 *     of the e2e seed, the project `storefront` whose remote is the fake GitHub, and one watch.
 *
 * Nothing reads ~/.majhi, port 7070, the live containers or any real host. Run it with
 * `MAJHI_E2E_PORT=7191 node --import tsx e2e/deploy-proof.ts` (docker must be running for the ssh host), then
 * drive it with `e2e/deploy-proof-run.ts` or by hand in a browser.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { startFakeHosts } from "../apps/server/src/deploy/testing/fake-hosts.ts";
import { generateKey, SecretStore } from "../apps/server/src/secrets/store.ts";
import { fakeAdapter, fakeUsage } from "../packages/acp/testing/index.ts";
import { sshTargetArgs } from "../packages/shared/src/index.ts";
import { E2E_PORT, E2E_ROOT, HOST_HOME, MAJHI_HOME, OFFLINE_FILE, SECRETS_KEY_FILE } from "./paths.ts";

// The server's own dependencies, resolved from its folder.
const need = createRequire(new URL("../apps/server/package.json", import.meta.url));
const { serve } = need("@hono/node-server") as typeof import("@hono/node-server");
const { parse, stringify } = need("yaml") as typeof import("yaml");

const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "majhi proof",
  GIT_AUTHOR_EMAIL: "proof@majhi.invalid",
  GIT_COMMITTER_NAME: "majhi proof",
  GIT_COMMITTER_EMAIL: "proof@majhi.invalid",
  GIT_SSH_COMMAND: "false",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: { ...process.env, ...gitEnv }, stdio: "pipe" }).toString().trim();

export const SSH_DIR = "/tmp/majhi-proof-ssh";
const SSH_PORT = 2299;

export interface Proof {
  url: string;
  hosts: Awaited<ReturnType<typeof startFakeHosts>>;
  repo: string;
  /** What the fake GitHub has on main: push of the proof's own. */
  push(sha?: string): string;
  /** An ssh command run on the container, for checks. */
  onHost(command: string): Promise<string>;
  stop(): Promise<void>;
}

const WORKFLOW = (name: string) => `name: ${name}
on:
  workflow_dispatch:
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - run: echo ship
`;

export async function startProof(): Promise<Proof> {
  rmSync(E2E_ROOT, { recursive: true, force: true });
  mkdirSync(MAJHI_HOME, { recursive: true });
  mkdirSync(dirname(SECRETS_KEY_FILE), { recursive: true });
  writeFileSync(SECRETS_KEY_FILE, `${await generateKey()}\n`, { mode: 0o600 });

  const hosts = await startFakeHosts({ pollsToFinish: 2 });
  const repo = join(HOST_HOME, "Work", "storefront");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  git(repo, "init", "--quiet", "--initial-branch", "main");
  writeFileSync(join(repo, "README.md"), "# storefront\n");
  writeFileSync(join(repo, ".github", "workflows", "deploy.yml"), WORKFLOW("Deploy"));
  writeFileSync(join(repo, ".github", "workflows", "preview.yml"), WORKFLOW("Preview"));
  writeFileSync(join(repo, "docker-compose.yml"), "services:\n  web:\n    image: acme/web\n");
  writeFileSync(join(repo, "vercel.json"), '{"name":"acme-storefront"}\n');
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "init");
  git(repo, "remote", "add", "origin", `http://${hosts.host}/acme/storefront.git`);
  const push = (sha = git(repo, "rev-parse", "main")) => {
    hosts.branches.set("github:acme/storefront:main", sha);
    return sha;
  };
  push();

  // The team of the e2e seed, then the proof's own workspace entries on top.
  await (await import("./home-seed.ts")).seedHome("team");
  const file = join(MAJHI_HOME, "majhi.yaml");
  const doc = parse(readFileSync(file, "utf8")) as Record<string, any>;
  doc.orgs.acme.mr_tokens = { github: "secret:proof-github" };
  doc.orgs.acme.connections = {
    "acme-github": { type: "git", name: "Acme GitHub", fields: { provider: "github", host: hosts.host } },
    "acme-host": { type: "ssh", name: "Acme VPS", fields: { alias: `deploy@127.0.0.1:${SSH_PORT}` } },
  };
  doc.projects = {
    storefront: {
      org: "acme",
      path: "~/Work/storefront",
      aliases: ["shop"],
      base: "main",
      remotes: { origin: { host: "github" } },
    },
  };
  writeFileSync(file, stringify(doc));
  await new SecretStore(MAJHI_HOME, SECRETS_KEY_FILE).set("proof-github", hosts.tokens.github);

  const fakes = {
    models: ["fake-model-a", "fake-model-b", "fake-model-c"],
    efforts: ["low", "medium", "high"],
    usage: { fiveHourPct: 42, weekPct: 18, opusPct: 30, plan: "max" },
  };
  const adapter = (tool: "claude" | "codex") => {
    const { command, args } = fakeAdapter(tool, { ...fakes, slowMs: 0 });
    return JSON.stringify([command, ...args]);
  };
  Object.assign(process.env, gitEnv, {
    MAJHI_HOST: "127.0.0.1",
    MAJHI_PORT: String(E2E_PORT),
    HOST_HOME,
    MAJHI_HOME,
    MAJHI_VERSION: "e2e",
    MAJHI_RUNNER: "local",
    MAJHI_SECRETS_KEY_FILE: SECRETS_KEY_FILE,
    MAJHI_ADAPTER_CLAUDE: adapter("claude"),
    MAJHI_ADAPTER_CODEX: adapter("codex"),
    MAJHI_USAGE_CLAUDE: JSON.stringify([fakeUsage(fakes).command, ...fakeUsage(fakes).args]),
    MAJHI_NET_PROBE: `file:${OFFLINE_FILE}`,
    MAJHI_NET_PROBE_MS: "500",
  });
  const { parseEnv } = await import("../apps/server/src/env.ts");
  const { createMajhi } = await import("../apps/server/src/server.ts");
  const { HostLink } = await import("../apps/server/src/host/link.ts");

  /** The same ssh the connections run, with the proof's own key and known hosts, so ~/.ssh is never read. */
  const remote = (alias: string, command: string) =>
    new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = execFile(
        "ssh",
        [
          "-i",
          join(SSH_DIR, "key"),
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
          ...sshTargetArgs(alias),
          command,
        ],
        { timeout: 60_000 },
        (err, stdout, stderr) => {
          const code = err === null ? 0 : typeof err.code === "number" ? err.code : null;
          resolve({ code, output: `${stdout}${stderr}`.trim() });
        },
      );
      child.stdin?.end();
    });

  const env = parseEnv();
  const majhi = createMajhi(env, {
    hostLink: new HostLink(),
    deploy: { vercelApi: hosts.url, remote, timing: { pollMs: 400, verifyMs: 400 } },
  });
  const server = serve({ fetch: majhi.app.fetch, hostname: env.host, port: env.port, createServer });
  majhi.attach(server);
  const url = `http://127.0.0.1:${env.port}`;
  return {
    url,
    hosts,
    repo,
    push,
    onHost: async (command) => (await remote(`deploy@127.0.0.1:${SSH_PORT}`, command)).output,
    async stop() {
      server.close();
      await majhi.close();
      await hosts.close();
    },
  };
}

/** POST /api/cmd/<name> as the owner. */
export async function cmd(url: string, name: string, input: unknown = {}): Promise<any> {
  const res = await fetch(`${url}/api/cmd/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-majhi-meta": JSON.stringify({ actor: { kind: "owner" } }) },
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as unknown;
  if (!res.ok) throw new Error(`${name}: ${JSON.stringify(body)}`);
  return body;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const proof = await startProof();
  console.log(`proof majhi on ${proof.url}, fake hosts on ${proof.hosts.url}`);
  process.once("SIGINT", () => void proof.stop().then(() => process.exit(0)));
  process.once("SIGTERM", () => void proof.stop().then(() => process.exit(0)));
}
