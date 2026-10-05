import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_TOOLS, type CliToolDef, type HostLoginProgress } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { CliToolLogins, parseIdentity, parseToolOutput, profileFolder } from "./cliTools.ts";

const TOKEN = "tok_FakeWorkspaceToken1234567890abcdef";
const PATH = process.env.PATH ?? "/usr/bin:/bin";

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

async function temp(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "majhi-clitool-")));
  dirs.push(dir);
  return dir;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * A fake command-line tool. `login --as <account> [--mode ok|hang|deny]` prints a page and a code,
 * writes its sign-in under XDG_CONFIG_HOME and the environment it ran with next to it; `whoami`
 * prints the account.
 */
async function fakeTool(dir: string): Promise<string> {
  const file = join(dir, "faketool");
  await writeFile(
    file,
    `#!/bin/sh
cmd="$1"; shift
account=""; mode=ok
while [ $# -gt 0 ]; do
  case "$1" in --as) account="$2"; shift;; --mode) mode="$2"; shift;; esac
  shift
done
case "$cmd" in
  login)
    echo $$ > "$XDG_CONFIG_HOME/pid"
    echo "Open https://example.test/device and enter code ABCD-EFGH" >&2
    "$BROWSER" "https://example.test/device"
    case "$mode" in
      hang) sleep 60 ;;
      deny) echo "error: access_denied for ${TOKEN}" >&2; exit 1 ;;
    esac
    mkdir -p "$XDG_CONFIG_HOME/fake"
    echo "$account" > "$XDG_CONFIG_HOME/fake/account"
    echo "${TOKEN}" > "$XDG_CONFIG_HOME/fake/token"
    env > "$XDG_CONFIG_HOME/fake/env"
    ;;
  whoami) cat "$XDG_CONFIG_HOME/fake/account" 2>/dev/null || exit 1 ;;
  logout) rm -rf "$XDG_CONFIG_HOME/fake"; touch "$XDG_CONFIG_HOME/logged-out" ;;
esac
`,
    { mode: 0o755 },
  );
  return file;
}

function toolDef(account: string, mode = "ok"): CliToolDef {
  const base = CLI_TOOLS.vercel;
  return {
    ...base,
    binary: "faketool",
    login: ["login", "--as", account, "--mode", mode],
    check: ["whoami"],
    logout: ["logout"],
  };
}

function logins(
  home: string,
  bin: string,
  account: string,
  extra: { mode?: string; timeoutMs?: number } = {},
) {
  return new CliToolLogins({
    majhiHome: home,
    path: PATH,
    find: async () => bin,
    env: { TMPDIR: "/tmp" },
    ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
    tools: { vercel: toolDef(account, extra.mode) },
  });
}

const config = (home: string, connection: string) => join(profileFolder(home, connection), "xdg", "config");

describe("parsing what a tool prints", () => {
  it("finds the page and the code, and a marked page wins", () => {
    expect(parseToolOutput("Open https://example.test/device and enter code ABCD-EFGH")).toEqual({
      url: "https://example.test/device",
      code: "ABCD-EFGH",
    });
    expect(parseToolOutput("MAJHI_LOGIN_URL https://acme.test/a\nsee https://other.test")).toMatchObject({
      url: "https://acme.test/a",
    });
    expect(parseToolOutput("nothing yet")).toEqual({});
  });

  it("reads who is signed in, and never a token-like line", () => {
    expect(parseIdentity("Logged in as ops@acme.test (id 5)")).toBe("ops@acme.test");
    expect(parseIdentity(`${TOKEN}\nacme-prod`)).toBe("acme-prod");
    expect(parseIdentity("api_key: sk_live_abcdef")).toBeUndefined();
  });
});

describe("a workspace's own sign-in", () => {
  it("keeps two workspaces apart: two accounts, two folders, a clean environment", async () => {
    const home = await temp();
    const bin = await fakeTool(home);
    process.env.CLOUDFLARE_API_TOKEN = "owner-global-token";
    process.env.AWS_SECRET_ACCESS_KEY = "owner-aws-secret";
    try {
      const pages: HostLoginProgress["login"][] = [];
      const a = await logins(home, bin, "ops@acme.test").login(
        { signIn: "sign-in-a", tool: "vercel", connection: "acme-cf" },
        (p) => pages.push(p.login),
      );
      const b = await logins(home, bin, "dev@globex.test").login(
        { signIn: "sign-in-b", tool: "vercel", connection: "globex-cf" },
        () => undefined,
      );
      expect(a).toEqual({ state: "done", identity: "ops@acme.test" });
      expect(b).toEqual({ state: "done", identity: "dev@globex.test" });
      expect(pages.at(-1)).toEqual({ url: "https://example.test/device", code: "ABCD-EFGH" });

      expect((await readFile(join(config(home, "acme-cf"), "fake", "account"), "utf8")).trim()).toBe(
        "ops@acme.test",
      );
      expect((await readFile(join(config(home, "globex-cf"), "fake", "account"), "utf8")).trim()).toBe(
        "dev@globex.test",
      );
      // Nothing of workspace B inside A's folder.
      expect(await exists(join(profileFolder(home, "acme-cf"), "..", "globex-cf"))).toBe(false);
      expect((await stat(profileFolder(home, "acme-cf"))).mode & 0o777).toBe(0o700);

      const seen = await readFile(join(config(home, "acme-cf"), "fake", "env"), "utf8");
      expect(seen).not.toContain("owner-global-token");
      expect(seen).not.toContain("owner-aws-secret");
      expect(seen).toContain(`HOME=${profileFolder(home, "acme-cf")}/home`);
      expect(seen).toContain(`XDG_CONFIG_HOME=${config(home, "acme-cf")}`);
    } finally {
      delete process.env.CLOUDFLARE_API_TOKEN;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    }
  });

  it("a refused login leaves nothing, says nothing of the tool's output, and keeps the old sign-in", async () => {
    const home = await temp();
    const bin = await fakeTool(home);
    await logins(home, bin, "ops@acme.test").login(
      { signIn: "first-signin", tool: "vercel", connection: "acme-cf" },
      () => undefined,
    );
    const err = await logins(home, bin, "x", { mode: "deny" })
      .login({ signIn: "second-signin", tool: "vercel", connection: "acme-cf" }, () => undefined)
      .then(
        () => undefined,
        (e: Error) => e,
      );
    expect(err?.message).toMatch(/refused/);
    expect(err?.message).not.toContain(TOKEN);
    expect((await readFile(join(config(home, "acme-cf"), "fake", "account"), "utf8")).trim()).toBe(
      "ops@acme.test",
    );
    expect((await readdirNames(join(home, "connections", "acme-cf"))).sort()).toEqual(["profile"]);
  });

  it("a first login that is refused leaves no folder at all", async () => {
    const home = await temp();
    const bin = await fakeTool(home);
    await expect(
      logins(home, bin, "x", { mode: "deny" }).login(
        { signIn: "only-signin", tool: "vercel", connection: "acme-cf" },
        () => undefined,
      ),
    ).rejects.toThrow();
    expect(await exists(profileFolder(home, "acme-cf"))).toBe(false);
  });

  it("a login that hangs times out, kills the tool and cleans up", async () => {
    const home = await temp();
    const bin = await fakeTool(home);
    const started = Date.now();
    await expect(
      logins(home, bin, "x", { mode: "hang", timeoutMs: 400 }).login(
        { signIn: "hang-signin", tool: "vercel", connection: "acme-cf" },
        () => undefined,
      ),
    ).rejects.toThrow(/ran out of time/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await exists(profileFolder(home, "acme-cf"))).toBe(false);
  });

  it("cancel stops the tool and keeps the old sign-in", async () => {
    const home = await temp();
    const bin = await fakeTool(home);
    const l = logins(home, bin, "x", { mode: "hang" });
    const pending = l.login(
      { signIn: "cancel-signin", tool: "vercel", connection: "acme-cf" },
      () => undefined,
    );
    await until(() => l.cancel("cancel-signin"));
    await expect(pending).resolves.toEqual({ state: "cancelled" });
    expect(await exists(profileFolder(home, "acme-cf"))).toBe(false);
  });

  it("refuses a reconnect that signs in as another account and keeps the old one", async () => {
    const home = await temp();
    const bin = await fakeTool(home);
    await logins(home, bin, "ops@acme.test").login(
      { signIn: "first-signin", tool: "vercel", connection: "acme-cf" },
      () => undefined,
    );
    const result = await logins(home, bin, "intruder@other.test").login(
      { signIn: "again-signin", tool: "vercel", connection: "acme-cf", expected: "ops@acme.test" },
      () => undefined,
    );
    expect(result).toEqual({ state: "other-account", identity: "intruder@other.test" });
    expect((await readFile(join(config(home, "acme-cf"), "fake", "account"), "utf8")).trim()).toBe(
      "ops@acme.test",
    );
  });

  it("does not run a tool that is not installed", async () => {
    const home = await temp();
    const l = new CliToolLogins({ majhiHome: home, path: PATH, find: async () => undefined });
    await expect(
      l.login({ signIn: "missing-signin", tool: "vercel", connection: "acme-cf" }, () => undefined),
    ).resolves.toEqual({ state: "missing" });
  });

  it("logout runs the tool's logout and removes the profile", async () => {
    const home = await temp();
    const bin = await fakeTool(home);
    const l = logins(home, bin, "ops@acme.test");
    await l.login({ signIn: "first-signin", tool: "vercel", connection: "acme-cf" }, () => undefined);
    expect((await l.check({ tool: "vercel", connection: "acme-cf" })).ok).toBe(true);
    await expect(l.logout({ tool: "vercel", connection: "acme-cf" })).resolves.toEqual({ revoked: true });
    expect(await exists(profileFolder(home, "acme-cf"))).toBe(false);
  });

  it("never lets a connection id leave its folder", async () => {
    const home = await temp();
    const bin = await fakeTool(home);
    await mkdir(join(home, "connections"), { recursive: true });
    await expect(
      logins(home, bin, "x").login(
        { signIn: "escape-signin", tool: "vercel", connection: "../../etc" },
        () => undefined,
      ),
    ).rejects.toThrow();
  });
});

async function readdirNames(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(dir);
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
