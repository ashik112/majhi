/**
 * Starts majhi and its host helper for Playwright against a throwaway home (`E2E_ROOT` in paths.ts,
 * shown here as <tmp>/majhi-e2e):
 *
 *   <tmp>/majhi-e2e/home/Work/alpha-api         GitHub remote, plus a `develop` branch one commit ahead of `main`
 *   <tmp>/majhi-e2e/home/Work/beta-web          GitLab remote over https, on `develop`
 *   <tmp>/majhi-e2e/home/Work/ops/gamma-infra   Bitbucket through the SSH alias `bitbucket-acme`
 *   <tmp>/majhi-e2e/home/Projects/delta-app     GitHub remote, so root suggestions have a second entry
 *   <tmp>/majhi-e2e/home/Empty                  no repos, so it is never suggested
 *   <tmp>/majhi-e2e/home/.ssh/config            defines that alias
 *   <tmp>/majhi-e2e/home/.majhi                 empty, so majhi starts in first-run (or seeded, see home-seed.ts)
 *   <tmp>/majhi-e2e/secrets/key                 throwaway age identity for secrets.age
 *
 * Agent CLIs are fake adapters that start signed out (see @majhi/acp/testing). Once signed in they
 * report 5-hour 42 % and weekly 18 % usage.
 *
 * The helper runs with that home as HOME and without MAJHI_REPO, so it browses
 * and suggests folders but never remounts (`canRemount` is false) and never
 * touches Docker. It reaches the server a moment after `/health` answers.
 *
 * The fixture (`fixture.ts`) runs it once per Playwright worker; the screenshot configs run it as their
 * web server. Expects `apps/web/dist` to be built already; the configs build it first.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKey } from "../apps/server/src/secrets/store.ts";
import { fakeAdapter, fakeUsage } from "../packages/acp/testing/index.ts";
import { E2E_PORT, E2E_ROOT, HOST_HOME, MAJHI_HOME, OFFLINE_FILE, SECRETS_KEY_FILE } from "./paths.ts";

// Keep the owner's own git config (signing, hooks, templates) out of the fixture and the server.
const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "majhi e2e",
  GIT_AUTHOR_EMAIL: "e2e@majhi.invalid",
  GIT_COMMITTER_NAME: "majhi e2e",
  GIT_COMMITTER_EMAIL: "e2e@majhi.invalid",
  // The fixture remotes are made up: fetching them must fail at once and never reach the network.
  GIT_SSH_COMMAND: "false",
};

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: { ...process.env, ...gitEnv }, stdio: "pipe" });
}

function makeRepo(dir: string, branch: string, remote: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "--initial-branch", branch);
  git(dir, "commit", "--quiet", "--allow-empty", "--message", "init");
  git(dir, "remote", "add", "origin", remote);
}

/** A `develop` branch one commit ahead of the checked-out branch, so "from develop" is provable. */
function addDevelop(dir: string, back: string): void {
  git(dir, "checkout", "--quiet", "-b", "develop");
  git(dir, "commit", "--quiet", "--allow-empty", "--message", "develop work");
  git(dir, "checkout", "--quiet", back);
}

rmSync(E2E_ROOT, { recursive: true, force: true });

const work = join(HOST_HOME, "Work");
makeRepo(join(work, "alpha-api"), "main", "git@github.com:acme/alpha-api.git");
addDevelop(join(work, "alpha-api"), "main");
makeRepo(join(work, "beta-web"), "develop", "https://gitlab.com/acme/beta-web.git");
makeRepo(join(work, "ops", "gamma-infra"), "main", "git@bitbucket-acme:acme/gamma-infra.git");
makeRepo(join(HOST_HOME, "Projects", "delta-app"), "main", "git@github.com:acme/delta-app.git");
mkdirSync(join(HOST_HOME, "Empty"));

mkdirSync(join(HOST_HOME, ".ssh"), { recursive: true });
writeFileSync(
  join(HOST_HOME, ".ssh", "config"),
  "Host bitbucket-acme\n  HostName bitbucket.org\n  User git\n  IdentityFile ~/.ssh/id_acme\n",
);
mkdirSync(MAJHI_HOME, { recursive: true });

// The age identity lives outside MAJHI_HOME, as it does in the container.
mkdirSync(dirname(SECRETS_KEY_FILE), { recursive: true });
writeFileSync(SECRETS_KEY_FILE, `${await generateKey()}\n`, { mode: 0o600 });

// The screenshot configs ask for a filled-in home (`ui`); a spec asks for its own through `useHome`.
const seed = process.env.MAJHI_E2E_SEED;
if (seed === "ui") (await import("./ui-seed.ts")).seedUiHome();
if (seed === "roots" || seed === "team" || seed === "team-api")
  await (await import("./home-seed.ts")).seedHome(seed);

// Fake adapters start signed out, so the login flow is real. Three models and three efforts
// make the editor's lists worth choosing from.
const fakes = {
  models: ["fake-model-a", "fake-model-b", "fake-model-c"],
  efforts: ["low", "medium", "high"],
  // Usage the fakes report once signed in: 5h 42 %, week 18 %, plus an Opus window.
  usage: { fiveHourPct: 42, weekPct: 18, opusPct: 30, plan: "max" },
};
// A pause between the steps of a turn lets a test see the plan pinned and the tools running, or stop a
// turn halfway with Esc. The fixture sets it per spec file (`useHome`), 0 unless the spec asks; a server
// started on its own keeps the old pauses.
const SLOW_MS = {
  claude: Number(process.env.MAJHI_E2E_SLOW_CLAUDE ?? 250),
  codex: Number(process.env.MAJHI_E2E_SLOW_CODEX ?? 600),
} as const;
const command = (tool: "claude" | "codex") => {
  const { command, args } = fakeAdapter(tool, { ...fakes, slowMs: SLOW_MS[tool] });
  return JSON.stringify([command, ...args]);
};

Object.assign(process.env, gitEnv, {
  MAJHI_HOST: "127.0.0.1",
  MAJHI_PORT: String(E2E_PORT),
  HOST_HOME,
  MAJHI_HOME,
  MAJHI_VERSION: "e2e",
  // Agents are the fake ACP agent, run next to majhi: e2e has no runner image.
  MAJHI_RUNNER: "local",
  MAJHI_SECRETS_KEY_FILE: SECRETS_KEY_FILE,
  MAJHI_ADAPTER_CLAUDE: command("claude"),
  MAJHI_ADAPTER_CODEX: command("codex"),
  MAJHI_USAGE_CLAUDE: JSON.stringify([fakeUsage(fakes).command, ...fakeUsage(fakes).args]),
  // Tests cannot cut the network: majhi counts as offline while this file exists, checked twice a second.
  MAJHI_NET_PROBE: `file:${OFFLINE_FILE}`,
  MAJHI_NET_PROBE_MS: "500",
});

// Dynamic on purpose: main.ts reads process.env as it loads, and a static import would run
// before the assignments above.
await import("../apps/server/src/main.ts");

// The helper runs under tsx like this script: the same node binary with the same loader flags.
const helperEnv: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: HOST_HOME,
  MAJHI_URL: `http://127.0.0.1:${E2E_PORT}`,
  MAJHI_HOME,
  MAJHI_HOST_VERSION: "e2e",
};
delete helperEnv.MAJHI_REPO;
const helper = spawn(
  process.execPath,
  [...process.execArgv, fileURLToPath(new URL("../apps/host/src/main.ts", import.meta.url))],
  { env: helperEnv, stdio: ["ignore", "inherit", "inherit"] },
);
process.once("exit", () => helper.kill());
