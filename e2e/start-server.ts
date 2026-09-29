/**
 * Starts majhi for Playwright against a throwaway home:
 *
 *   <tmp>/majhi-e2e/home/Work/alpha-api        GitHub remote
 *   <tmp>/majhi-e2e/home/Work/beta-web         GitLab remote over https, on `develop`
 *   <tmp>/majhi-e2e/home/Work/ops/gamma-infra  Bitbucket through the SSH alias `bitbucket-acme`
 *   <tmp>/majhi-e2e/home/.ssh/config           defines that alias
 *   <tmp>/majhi-e2e/home/.majhi                empty, so majhi starts in first-run
 *
 * Expects `apps/web/dist` to be built already; the Playwright config builds it first.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_PORT, E2E_ROOT, HOST_HOME, MAJHI_HOME } from "./fixture.ts";

// Keep the owner's own git config (signing, hooks, templates) out of the fixture and the server.
const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "majhi e2e",
  GIT_AUTHOR_EMAIL: "e2e@majhi.invalid",
  GIT_COMMITTER_NAME: "majhi e2e",
  GIT_COMMITTER_EMAIL: "e2e@majhi.invalid",
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

rmSync(E2E_ROOT, { recursive: true, force: true });

const work = join(HOST_HOME, "Work");
makeRepo(join(work, "alpha-api"), "main", "git@github.com:acme/alpha-api.git");
makeRepo(join(work, "beta-web"), "develop", "https://gitlab.com/acme/beta-web.git");
makeRepo(join(work, "ops", "gamma-infra"), "main", "git@bitbucket-acme:acme/gamma-infra.git");

mkdirSync(join(HOST_HOME, ".ssh"), { recursive: true });
writeFileSync(
  join(HOST_HOME, ".ssh", "config"),
  "Host bitbucket-acme\n  HostName bitbucket.org\n  User git\n  IdentityFile ~/.ssh/id_acme\n",
);
mkdirSync(MAJHI_HOME, { recursive: true });

Object.assign(process.env, gitEnv, {
  MAJHI_HOST: "127.0.0.1",
  MAJHI_PORT: String(E2E_PORT),
  HOST_HOME,
  MAJHI_HOME,
  MAJHI_VERSION: "e2e",
});

// Dynamic on purpose: main.ts reads process.env as it loads, and a static import would run
// before the assignments above.
await import("../apps/server/src/main.ts");
