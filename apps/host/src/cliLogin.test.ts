import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostLoginProgress } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { CliLogins, loginDir, parseLoginOutput } from "./cliLogin.ts";
import { findExecutable } from "./paths.ts";

const TOKEN = "gho_FakeWorkspaceToken1234567890";
const GL_TOKEN = "glo_FakeGitLabAccess99887766";
const GL_REFRESH = "glrt_FakeGitLabRefresh5544";
const OWNER_TOKEN = "ghp_OwnersOwnGlobalToken000111";
const PATH = process.env.PATH ?? "/usr/bin:/bin";

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

async function temp(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "majhi-cli-")));
  dirs.push(dir);
  return dir;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function until(check: () => Promise<boolean> | boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * A fake `gh` or `glab` in a temp bin folder. It records what it saw in `seen`, prints what the real
 * one prints, then waits for `approve` (the owner approving in the browser) and writes its config.
 */
async function fakeCli(
  dir: string,
  cli: "gh" | "glab",
  options: { exit?: number; noToken?: boolean; noise?: string } = {},
) {
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  const seen = join(dir, `${cli}-seen.txt`);
  const approve = join(dir, `${cli}-approve`);
  const pid = join(dir, `${cli}-pid`);
  const configDirVar = cli === "gh" ? "GH_CONFIG_DIR" : "GLAB_CONFIG_DIR";
  const config =
    cli === "gh"
      ? `github.com:\n    users:\n        octo-acme:\n            oauth_token: ${TOKEN}\n    git_protocol: https\n    oauth_token: ${TOKEN}\n    user: octo-acme\n`
      : `hosts:\n  gitlab.com:\n    token: ${GL_TOKEN}\n    oauth2_refresh_token: ${GL_REFRESH}\n    oauth2_expiry_date: 2026-10-03T14:00:00+02:00\n    is_oauth2: "true"\n`;
  const file = cli === "gh" ? "hosts.yml" : "config.yml";
  const print =
    cli === "gh"
      ? `echo "! One-time code (AB12-CD34) copied to clipboard" >&2\n"$BROWSER" "https://github.com/login/device"\necho "Open this URL to continue in your web browser: https://github.com/login/device" >&2`
      : `"$BROWSER" "https://gitlab.com/oauth/authorize?client_id=abc&state=xyz"`;
  const script = `#!/bin/sh
echo $$ > "${pid}"
{
  echo "CONFIG=$${configDirVar}"
  echo "HOME=$HOME"
  echo "GH_TOKEN=$GH_TOKEN"
  echo "ARGS=$*"
} > "${seen}"
${print}
${options.noise === undefined ? "" : `echo "${options.noise}" >&2`}
while [ ! -f "${approve}" ]; do sleep 0.05; done
${options.noToken === true ? "" : `printf '%s' '${config}' > "$${configDirVar}/${file}"`}
exit ${options.exit ?? 0}
`;
  await writeFile(join(bin, cli), script, { mode: 0o755 });
  return {
    path: `${bin}:${PATH}`,
    seen: async () => readFile(seen, "utf8"),
    approve: () => writeFile(approve, ""),
    pid: async () => Number((await readFile(pid, "utf8")).trim()),
  };
}

function logins(dir: string, path: string) {
  const majhiHome = join(dir, ".majhi");
  return {
    majhiHome,
    logins: new CliLogins({
      majhiHome,
      path,
      find: (cli) => findExecutable(cli, path),
      // The helper's own environment, which must never reach the CLI.
      env: { GH_TOKEN: OWNER_TOKEN, GH_CONFIG_DIR: "/Users/owner/.config/gh", TMPDIR: tmpdir() },
    }),
  };
}

describe("parseLoginOutput", () => {
  it("finds gh's one-time code and the device page", () => {
    const text =
      "\n! One-time code (4F84-DF73) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device\n";
    expect(parseLoginOutput(text)).toEqual({ code: "4F84-DF73", url: "https://github.com/login/device" });
  });

  it("finds the code in gh's older wording and the page from majhi's browser script", () => {
    const text =
      "! First copy your one-time code: WDJB-MJHT\nMAJHI_LOGIN_URL https://github.com/login/device\n";
    expect(parseLoginOutput(text)).toEqual({ code: "WDJB-MJHT", url: "https://github.com/login/device" });
  });

  it("finds nothing before the CLI printed it, and ignores a page that is not http", () => {
    expect(parseLoginOutput("- Logging in to github.com\n")).toEqual({});
    expect(parseLoginOutput("MAJHI_LOGIN_URL file:///etc/passwd\n")).toEqual({});
  });
});

describe("CliLogins", () => {
  it("signs in with gh in the workspace's own config folder, never the owner's, and removes it after", async () => {
    const dir = await temp();
    const cli = await fakeCli(dir, "gh");
    const { majhiHome, logins: runner } = logins(dir, cli.path);
    const progress: Omit<HostLoginProgress, "id">[] = [];
    const done = runner.login(
      { signIn: "si_acmeGh0000001", cli: "gh", org: "acme", host: "github.com" },
      (p) => progress.push(p),
    );
    await until(() => progress.length > 0);
    expect(progress).toEqual([{ login: { url: "https://github.com/login/device", code: "AB12-CD34" } }]);

    const workDir = loginDir(majhiHome, "acme", "gh");
    expect(((await stat(workDir)).mode & 0o777).toString(8)).toBe("700");
    expect(((await stat(join(majhiHome, "git", "acme"))).mode & 0o777).toString(8)).toBe("700");
    const seen = await cli.seen();
    expect(seen).toContain(`CONFIG=${join(workDir, "config")}`);
    expect(seen).toContain(`HOME=${join(workDir, "home")}`);
    expect(seen).toContain("GH_TOKEN=\n");
    expect(seen).not.toContain("/Users/owner");
    expect(seen).toContain("--insecure-storage");
    expect(seen).toContain("--scopes repo,read:org,workflow");

    await cli.approve();
    expect(await done).toEqual({ state: "done", token: TOKEN });
    expect(await exists(workDir)).toBe(false);
    expect(JSON.stringify(progress)).not.toContain(TOKEN);
  });

  it("reads glab's token, refresh token and expiry for gitlab.com", async () => {
    const dir = await temp();
    const cli = await fakeCli(dir, "glab");
    const { logins: runner } = logins(dir, cli.path);
    const progress: Omit<HostLoginProgress, "id">[] = [];
    const done = runner.login(
      { signIn: "si_acmeGl0000001", cli: "glab", org: "acme", host: "gitlab.com" },
      (p) => progress.push(p),
    );
    await until(() => progress.length > 0);
    expect(progress[0]?.login.url).toBe("https://gitlab.com/oauth/authorize?client_id=abc&state=xyz");
    expect(progress[0]?.login.code).toBeUndefined();
    await cli.approve();
    expect(await done).toEqual({
      state: "done",
      token: GL_TOKEN,
      refreshToken: GL_REFRESH,
      expiresAt: "2026-10-03T12:00:00.000Z",
    });
  });

  it("keeps two workspaces apart: each gets its own folder and token file", async () => {
    const dir = await temp();
    const cli = await fakeCli(dir, "gh");
    const { majhiHome } = logins(dir, cli.path);
    expect(loginDir(majhiHome, "acme", "gh")).not.toBe(loginDir(majhiHome, "globex", "gh"));
    expect(() => loginDir(majhiHome, "../owner", "gh")).toThrow();
  });

  it("cancel kills the CLI and saves nothing", async () => {
    const dir = await temp();
    const cli = await fakeCli(dir, "gh");
    const { majhiHome, logins: runner } = logins(dir, cli.path);
    let told = false;
    const done = runner.login(
      { signIn: "si_acmeGh0000002", cli: "gh", org: "acme", host: "github.com" },
      () => {
        told = true;
      },
    );
    await until(() => told);
    const pid = await cli.pid();
    expect(runner.cancel("si_acmeGh0000002")).toBe(true);
    expect(await done).toEqual({ state: "cancelled" });
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(await exists(loginDir(majhiHome, "acme", "gh"))).toBe(false);
    expect(runner.cancel("si_acmeGh0000002")).toBe(false);
  });

  it("answers missing when the CLI is not installed, and runs nothing", async () => {
    const dir = await temp();
    const { majhiHome, logins: runner } = logins(dir, join(dir, "empty-bin"));
    const result = await runner.login(
      { signIn: "si_acmeGh0000003", cli: "gh", org: "acme", host: "github.com" },
      () => undefined,
    );
    expect(result).toEqual({ state: "missing" });
    expect(await exists(join(majhiHome, "git"))).toBe(false);
  });

  it("a failed CLI gives a fixed sentence, never its output", async () => {
    const dir = await temp();
    const cli = await fakeCli(dir, "gh", { exit: 1, noise: `token ${TOKEN} was refused` });
    const { logins: runner } = logins(dir, cli.path);
    let told = false;
    const done = runner.login(
      { signIn: "si_acmeGh0000004", cli: "gh", org: "acme", host: "github.com" },
      () => {
        told = true;
      },
    );
    await until(() => told);
    await cli.approve();
    const err = await done.then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toBe("The sign-in was refused on GitHub. Nothing was saved.");
    expect(err?.message).not.toContain(TOKEN);
  });

  it("a CLI that exits 0 but wrote no token fails without reading any other login", async () => {
    const dir = await temp();
    const cli = await fakeCli(dir, "gh", { noToken: true });
    const { logins: runner } = logins(dir, cli.path);
    let told = false;
    const done = runner.login(
      { signIn: "si_acmeGh0000005", cli: "gh", org: "acme", host: "github.com" },
      () => {
        told = true;
      },
    );
    await until(() => told);
    await cli.approve();
    await expect(done).rejects.toThrow("gh finished, but left no token for github.com.");
  });
});
