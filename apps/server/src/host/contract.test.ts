import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import {
  CLI_TOOLS,
  type CliToolDef,
  cliLoginEnv,
  cliProfileFolders,
  HostInfoSchema,
  type HostMethod,
  type HostProgress,
  HostResultSchemas,
  UpdateStatusSchema,
} from "@majhi/shared";
import { Encrypter, identityToRecipient } from "age-encryption";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKey } from "../secrets/store.ts";
import { createMajhiApp } from "../server.ts";
import { git, makeRepo, tempDir, testEnv } from "../testing/fixtures.ts";
import { hostBinary } from "../testing/hostBinary.ts";
import { HostJobError, HostLink, type HostParams, type HostResult } from "./link.ts";

/**
 * The contract between the Go host helper and the shared schemas (packages/shared/src/host.ts),
 * which stay the single source of truth. The helper runs here as `cmd/contract`: its real client,
 * jobs and handlers over a fake platform (keyring, agent, notifier, editor, browser, clipboard and
 * Docker starter in memory). The server side is the production one: `HostLink` checks every result
 * against `HostResultSchemas[method]`, and the routes check the `x-majhi-host` header against
 * `HostInfoSchema`, every reply against `HostReplySchema` and every progress against
 * `HostProgressSchema`. A mismatch fails the test. The programs the helper runs (docker, git network
 * calls, ssh, gh, vercel) are stand-ins on its PATH.
 *
 * The test builds the helper through scripts/build-host.sh (Go in a container) when it is missing.
 * It never skips.
 */

const DOCKER = `#!/bin/sh
echo "$*" >> "$DOCKER_LOG"
case "$1" in
  info) echo OrbStack ;;
  compose)
    case "$*" in
      *gen-override*) echo "services: {}" ;;
      *" ps "*) echo abc ;;
      *logs*) echo "server-1  | listening" ;;
    esac ;;
  image) [ "$2" = inspect ] && echo sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
  create) echo cid1 ;;
  cp) echo helper > "$3" ;;
  container) exit 1 ;;
  system) printf 'Build Cache\\t1GB\\n' ;;
  run) echo AGE-SECRET-KEY-UNUSED ;;
esac
exit 0
`;

// git: the network calls are faked and the rest is the real git. The helper gives git an exact
// environment, so the paths are written into the script.
const gitScript = (realGit: string, pushLog: string) => `#!/bin/sh
if [ "$1" = credential ]; then cat > /dev/null; printf 'password=hunter2-test\\n'; exit 0; fi
for a in "$@"; do
  if [ "$a" = push ]; then echo "$*" >> ${pushLog}; exit 0; fi
done
exec ${realGit} "$@"
`;

const SSH_ADD = `#!/bin/sh
[ "$1" = "-l" ] && { echo "The agent has no identities."; exit 1; }
exit 0
`;

const SSH = `#!/bin/sh
case "$*" in
  *github.com*) echo "Hi acme-ssh! You've successfully authenticated, but GitHub does not provide shell access."; exit 1 ;;
  *) echo "git@host: Permission denied (publickey)." >&2; exit 255 ;;
esac
`;

const GH = `#!/bin/sh
case "$1 $2" in
  "auth status") printf 'github.com\\n  ✓ Logged in to github.com account acme-dev (keyring)\\n' ;;
  "auth token") echo ghp_faketoken123 ;;
  "auth login")
    echo "! First copy your one-time code: ABCD-1234"
    "$BROWSER" https://github.com/login/device
    printf 'github.com:\\n    oauth_token: gho_fakelogintoken\\n    user: acme-dev\\n' > "$GH_CONFIG_DIR/hosts.yml" ;;
esac
exit 0
`;

const VERCEL = `#!/bin/sh
case "$1" in
  login) echo "Visit https://vercel.com/oauth/device?user_code=ABCD-EFGH"; mkdir -p "$XDG_DATA_HOME"; echo in > "$XDG_DATA_HOME/signed-in" ;;
  whoami) [ -f "$XDG_DATA_HOME/signed-in" ] && { echo dev@acme.test; exit 0; }; exit 1 ;;
  logout) rm -f "$XDG_DATA_HOME/signed-in" ;;
esac
exit 0
`;

/** Stands in for the Laya service the helper starts: prints its port, answers `/predict`. */
const FAKE_PYTHON = `#!/usr/bin/env node
const http = require("node:http");
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== "Bearer " + process.env.MAJHI_LAYA_TOKEN) { res.writeHead(401); res.end("{}"); return; }
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      answers: { q1: { type: "choice", confidence: 0.9, choice: "yes", probabilities: { yes: 0.9, no: 0.1 } } },
      loadMs: 0, predictMs: 3,
    }));
  });
});
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ ready: true, port: server.address().port })));
`;

async function script(dir: string, name: string, text: string): Promise<void> {
  await writeFile(join(dir, name), text);
  await chmod(join(dir, name), 0o755);
}

let BINARY = "";

describe("the Go host helper against the shared schemas", { timeout: 120_000 }, () => {
  const called = new Set<string>();
  let cleanup: () => Promise<void>;
  let helper: ChildProcess;
  let link: HostLink;
  let server: ReturnType<typeof serve>;
  let home: string;
  let majhiHome: string;
  let repo: string;
  let work: string;
  let dockerLog: string;
  let pushLog: string;
  let secretsKey: string;
  let helperOutput = "";
  let helperExit: Promise<number | null>;

  /** `link.call` that also notes the method was exercised and collects its progress. */
  async function call<M extends HostMethod>(
    method: M,
    params: HostParams<M>,
    timeoutMs = 30_000,
  ): Promise<{ result: HostResult<M>; progress: HostProgress[] }> {
    called.add(method);
    const progress: HostProgress[] = [];
    const result = await link.call(method, params, timeoutMs, (p) => progress.push(p));
    return { result, progress };
  }

  beforeAll(async () => {
    BINARY = hostBinary("contract");
    let dir: string;
    ({ dir, cleanup } = await tempDir());
    dir = await realpath(dir);
    const env = testEnv(dir, { version: "contract" });
    majhiHome = env.majhiHome;
    home = join(dir, "home");
    repo = join(dir, "majhi-checkout");
    work = join(home, "Work");
    dockerLog = join(dir, "docker.log");
    pushLog = join(dir, "push.log");
    const bin = join(dir, "bin");
    await mkdir(bin);
    await mkdir(majhiHome, { recursive: true });
    await mkdir(join(home, ".ssh"), { recursive: true });
    await mkdir(join(home, ".config", "majhi"), { recursive: true });

    // The majhi checkout the helper runs docker compose in: two commits.
    await makeRepo(repo, { commit: true });
    await git(repo, "commit", "--quiet", "--allow-empty", "-m", "second change");

    // Folders to browse, and repos in them.
    await makeRepo(join(work, "alpha"), { commit: true });
    await makeRepo(join(work, "beta"), { commit: true });
    await mkdir(join(home, "Empty"));
    await writeFile(join(home, "notes.txt"), "line 1\nline 2\nline 3\n");

    // A project with a remote to push to, a bare repo to clone, and an empty bare one.
    await makeRepo(join(dir, "project"), { branch: "main", commit: true });
    await git(join(dir, "project"), "remote", "add", "origin", "https://github.com/acme/api.git");
    const source = join(dir, "source");
    await makeRepo(source, { branch: "trunk", commit: true });
    await writeFile(join(source, "README.md"), "# demo\n");
    await git(source, "add", ".");
    await git(source, "commit", "--quiet", "-m", "readme");
    await git(dir, "clone", "--quiet", "--bare", source, join(dir, "demo.git"));
    await git(dir, "init", "--quiet", "--bare", join(dir, "empty.git"));

    // A secrets key and the secrets.age it opens.
    secretsKey = await generateKey();
    await writeFile(join(home, ".config", "majhi", "secrets.key"), `${secretsKey}\n`, { mode: 0o600 });
    const sealed = new Encrypter();
    sealed.addRecipient(await identityToRecipient(secretsKey));
    await writeFile(join(majhiHome, "secrets.age"), await sealed.encrypt("hello"));

    // A passphrase-protected key with an accented name, so the poll header carries non-ASCII.
    execFileSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "correct horse battery",
      "-f",
      join(home, ".ssh", "id_café"),
    ]);
    await writeFile(join(home, ".ssh", "config"), "Host *\n  IdentityFile ~/.ssh/id_café\n");

    // Laya: installed, with a stand-in for its Python.
    await mkdir(join(majhiHome, "laya", "venv", "bin"), { recursive: true });
    await writeFile(
      join(majhiHome, "laya", "installed.json"),
      JSON.stringify({
        version: "0.2.0",
        model: "aac6fef/laya-mlx",
        installedAt: "2026-10-21T00:00:00.000Z",
      }),
    );
    await script(join(majhiHome, "laya", "venv", "bin"), "python", FAKE_PYTHON);

    const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
    await script(bin, "docker", DOCKER);
    await script(bin, "git", gitScript(realGit, pushLog));
    await script(bin, "ssh-add", SSH_ADD);
    await script(bin, "ssh", SSH);
    await script(bin, "gh", GH);
    await script(bin, "vercel", VERCEL);
    // Editors the helper would otherwise find on this computer and open for real.
    await script(bin, "code", "#!/bin/sh\nexit 0\n");
    await script(bin, "cursor", "#!/bin/sh\nexit 0\n");

    link = new HostLink({ pollTimeoutMs: 5_000 });
    const app = createMajhiApp(env, { hostLink: link });
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => resolve(info.port));
    });

    helper = spawn(BINARY, [], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        MAJHI_URL: `http://127.0.0.1:${port}`,
        MAJHI_HOME: majhiHome,
        MAJHI_REPO: repo,
        MAJHI_HOST_VERSION: "contract",
        MAJHI_HOST_SSH: join(bin, "ssh"),
        DOCKER_LOG: dockerLog,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    helper.stdout?.on("data", (c: Buffer) => {
      helperOutput += c.toString();
    });
    helper.stderr?.on("data", (c: Buffer) => {
      helperOutput += c.toString();
    });
    helperExit = new Promise((resolve) => helper.once("exit", (code) => resolve(code)));
    // The first poll tells the server the helper is there.
    for (let i = 0; i < 100 && !link.isConnected(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(link.isConnected(), helperOutput).toBe(true);
  }, 660_000);

  afterAll(async () => {
    helper?.kill();
    server?.close();
    link?.close();
    await cleanup?.();
  });

  it("sends a poll header that HostInfoSchema accepts, with non-ASCII intact", async () => {
    const { result } = await call("ssh.reload", {});
    expect(result.needsPassphrase).toEqual(["~/.ssh/id_café"]);
    // The next poll carries it, through the header the routes parse with HostInfoSchema.
    await call("machine.read", {});
    const info = HostInfoSchema.parse(link.status().info);
    expect(info).toMatchObject({
      version: "contract",
      os: "macos",
      canRemount: true,
      platform: process.platform,
    });
    expect(info.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(info.dirty).toBe(false);
    expect(info.ssh?.needsPassphrase).toEqual(["~/.ssh/id_café"]);
    expect(info.keyring).toEqual({ kind: "keychain" });
  });

  it("lists, makes and suggests folders", async () => {
    const listing = (await call("listDirs", { path: "~", showHidden: false })).result;
    expect(listing.home).toBe(home);
    expect(listing.entries.map((e) => e.name)).toEqual(["Empty", "Work"]);
    const alpha = (await call("listDirs", { path: join(work, "alpha"), showHidden: true })).result;
    expect(alpha.parent).toBe(work);
    const inWork = (await call("listDirs", { path: work, showHidden: false })).result;
    expect(inWork.entries).toEqual([
      { name: "alpha", path: join(work, "alpha"), isRepo: true, hidden: false },
      { name: "beta", path: join(work, "beta"), isRepo: true, hidden: false },
    ]);
    await expect(call("listDirs", { path: "/definitely/not/here", showHidden: false })).rejects.toThrow(
      HostJobError,
    );
    expect((await call("fs.mkdir", { path: "~/Made/new" })).result).toEqual({
      path: join(home, "Made", "new"),
    });
    expect((await stat(join(home, "Made", "new"))).isDirectory()).toBe(true);
    await expect(call("fs.mkdir", { path: "/etc/majhi-test" })).rejects.toThrow(
      "majhi only makes folders inside your home folder.",
    );
    expect((await call("suggestRoots", {})).result.suggestions).toEqual([{ path: work, repoCount: 2 }]);
  });

  it("reads this computer", async () => {
    const machine = (await call("machine.read", {})).result;
    expect(machine.cores).toBeGreaterThan(0);
    expect(machine.memTotalBytes).toBeGreaterThan(0);
  });

  it("keeps SSH keys: reloads, makes a key, takes a passphrase", async () => {
    const made = (await call("ssh.keygen", {})).result;
    expect(made.path).toBe("~/.ssh/id_ed25519");
    expect(made.publicKey).toMatch(/^ssh-ed25519 /);
    expect(made.fingerprint).toMatch(/^SHA256:/);
    const unlocked = (
      await call("ssh.unlock", { key: "~/.ssh/id_café", passphrase: "correct horse battery" })
    ).result;
    expect(unlocked.checkedAt).toMatch(/Z$/);
    await expect(call("ssh.unlock", { key: "~/.ssh/id_nothing", passphrase: "x" })).rejects.toThrow(
      "is not waiting for a passphrase",
    );
  });

  it("saves and restores the secrets key, never replacing one that works", async () => {
    const { createHash } = await import("node:crypto");
    const fingerprint = createHash("sha256").update(secretsKey).digest("hex").slice(0, 16);
    expect((await call("secretsKey.save", { expected: fingerprint })).result.saved).toBe(fingerprint);
    await expect(call("secretsKey.save", { expected: "0".repeat(16) })).rejects.toThrow(
      "is not the key majhi uses",
    );
    // The key file works, so a restore leaves it alone.
    expect((await call("secretsKey.restore", { key: secretsKey })).result).toEqual({
      written: false,
      restarts: true,
    });
    // Another key does not open secrets.age, so it is refused.
    await expect(call("secretsKey.restore", { key: await generateKey() })).rejects.toThrow(
      "does not open secrets.age",
    );
    // A lost key file comes back from the export, mode 600.
    const file = join(home, ".config", "majhi", "secrets.key");
    await writeFile(file, "AGE-SECRET-KEY-NOT-A-KEY\n");
    const restored = (await call("secretsKey.restore", { key: secretsKey })).result;
    expect(restored.written).toBe(true);
    expect(restored.keptAside).toContain("secrets.key.old-");
    expect((await readFile(file, "utf8")).trim()).toBe(secretsKey);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("does the desktop jobs", async () => {
    expect(
      (await call("editor.open", { app: "vscode", path: join(home, "notes.txt"), line: 2 })).result,
    ).toEqual({
      opened: true,
    });
    expect(
      (await call("notify", { title: "majhi", message: "Done", path: "/t/ACM-12", sound: false })).result,
    ).toEqual({ shown: true, clickable: true });
    expect((await call("notify.openSettings", {})).result).toEqual({ opened: true });
    expect((await call("openUrl", { url: "https://example.com/page" })).result).toEqual({ opened: true });
    expect((await call("clipboard.copy", { text: "copied text" })).result).toEqual({ copied: true });
  });

  it("answers git jobs: logins, tokens, credentials, push, clone, ls-remote", async () => {
    const logins = (await call("git.logins", { extraHosts: ["gitlab.acme.test"] })).result;
    expect(logins.hosts).toEqual([
      {
        host: "github.com",
        logins: [
          { via: "gh", account: "acme-dev" },
          { via: "ssh", account: "acme-ssh" },
        ],
      },
    ]);
    expect((await call("git.token", { via: "gh", host: "github.com" })).result).toEqual({
      token: "ghp_faketoken123",
    });
    expect((await call("git.credential", { host: "github.com", username: "acme" })).result).toEqual({
      secret: "hunter2-test",
    });

    const project = join(home, "..", "project");
    const auth = { kind: "token", username: "x-access-token", password: "ghp_pushtoken" } as const;
    expect(
      (
        await call("git.push", {
          path: project,
          url: "https://github.com/acme/api.git",
          branch: "main",
          auth,
          setUpstream: true,
        })
      ).result,
    ).toEqual({ pushed: true });
    const pushed = await readFile(pushLog, "utf8");
    expect(pushed).toContain(
      "-c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.ext.allow=never",
    );
    expect(pushed).toContain(
      "push --receive-pack=git-receive-pack --quiet https://github.com/acme/api.git refs/heads/main:refs/heads/main",
    );
    expect(pushed).not.toContain("ghp_pushtoken");
    expect(await git(project, "config", "branch.main.remote")).toBe("origin");
    for (const [params, message] of [
      [{ url: "git@github.com:acme/api.git", branch: "main" }, "Only https remotes"],
      [{ url: "https://github.com/acme/api.git", branch: "+main" }, "not a plain branch name"],
      [{ url: "https://github.com/acme/api.git", branch: ":main" }, "not a plain branch name"],
    ] as const) {
      await expect(call("git.push", { path: project, ...params })).rejects.toThrow(message);
    }

    const target = join(work, "cloned");
    const { result, progress } = await call("git.clone", {
      clone: "cl_AAAAAAAAAAAAAAAA",
      url: join(home, "..", "demo.git"),
      path: target,
      auth: { kind: "none" },
    });
    expect(result.branch).toBe("trunk");
    expect(await readFile(join(target, "README.md"), "utf8")).toBe("# demo\n");
    expect(progress[0]).toEqual({ id: expect.any(String), phase: "connecting" });
    expect(progress.at(-1)).toMatchObject({ phase: "checkout", percent: 100 });
    await expect(
      call("git.clone", {
        clone: "cl_BBBBBBBBBBBBBBBB",
        url: join(home, "..", "demo.git"),
        path: target,
        auth: { kind: "none" },
      }),
    ).rejects.toThrow("already exists and is not empty");

    expect(
      (await call("git.lsRemote", { url: join(home, "..", "demo.git"), auth: { kind: "none" } })).result,
    ).toEqual({
      empty: false,
      defaultBranch: "trunk",
    });
    expect(
      (await call("git.lsRemote", { url: join(home, "..", "empty.git"), auth: { kind: "none" } })).result,
    ).toEqual({
      empty: true,
    });
  });

  it("signs in to git CLIs and command-line tools in folders of their own", async () => {
    const gh = await call("git.cliLogin", {
      signIn: "si_AAAAAAAAAAAA",
      cli: "gh",
      org: "acme",
      host: "github.com",
    });
    expect(gh.result).toEqual({ state: "done", token: "gho_fakelogintoken" });
    expect(gh.progress).toEqual([
      { id: expect.any(String), login: { url: "https://github.com/login/device", code: "ABCD-1234" } },
    ]);
    // The workspace's folder is gone when the job ends.
    await expect(stat(join(majhiHome, "git", "acme", "gh"))).rejects.toThrow();
    expect((await call("git.cliLoginCancel", { signIn: "si_BBBBBBBBBBBB" })).result).toEqual({
      cancelled: false,
    });

    const login = await call("cli.login", {
      signIn: "si_CCCCCCCCCCCC",
      tool: "vercel",
      connection: "acme-vercel",
    });
    expect(login.result).toEqual({ state: "done", identity: "dev@acme.test" });
    expect(login.progress).toEqual([
      {
        id: expect.any(String),
        login: { url: "https://vercel.com/oauth/device?user_code=ABCD-EFGH", code: "ABCD-EFGH" },
      },
    ]);
    expect((await call("cli.loginCancel", { signIn: "si_DDDDDDDDDDDD" })).result).toEqual({
      cancelled: false,
    });
    expect((await call("cli.check", { tool: "vercel", connection: "acme-vercel" })).result).toEqual({
      ok: true,
      identity: "dev@acme.test",
      detail: "Signed in.",
    });
    expect((await call("cli.logout", { tool: "vercel", connection: "acme-vercel" })).result).toEqual({
      revoked: true,
    });
    await expect(stat(join(majhiHome, "connections", "acme-vercel", "profile"))).rejects.toThrow();
    // A tool that is not installed.
    expect(
      (await call("cli.login", { signIn: "si_EEEEEEEEEEEE", tool: "stripe", connection: "acme-stripe" }))
        .result,
    ).toEqual({
      state: "missing",
    });
  });

  it("answers Laya's jobs", async () => {
    expect((await call("decisions.status", {})).result).toEqual({ state: "ready", version: "0.2.0" });
    expect((await call("decisions.install", {})).result).toEqual({ state: "ready", version: "0.2.0" });
    const decided = (
      await call("decide", {
        state: "A task ends",
        questions: { q1: { type: "choice", instructions: "Is it done?", criteria: ["yes", "no"] } },
      })
    ).result;
    expect(decided.answers.q1).toMatchObject({ type: "choice", choice: "yes" });
    expect((await call("decisions.status", {})).result.state).toBe("loaded");
  });

  it("reads the checkout, remounts and updates", async () => {
    const first = (await git(repo, "rev-list", "--max-parents=0", "HEAD")).trim();
    const head = (await git(repo, "rev-parse", "HEAD")).trim();
    expect((await call("version.changes", { from: first })).result).toEqual({
      head,
      dirty: false,
      changes: ["second change"],
    });
    expect((await call("remount", {})).result).toEqual({ accepted: true });
    await waitFor(async () => (await readFile(dockerLog, "utf8")).includes("compose up -d --wait"));
    expect(await readFile(dockerLog, "utf8")).toContain("gen-override");

    expect((await call("update", {})).result).toEqual({ accepted: true });
    const statusFile = join(majhiHome, "update.json");
    await waitFor(async () => {
      const status = UpdateStatusSchema.parse(JSON.parse(await readFile(statusFile, "utf8")));
      return status.state !== "running";
    });
    const status = UpdateStatusSchema.parse(JSON.parse(await readFile(statusFile, "utf8")));
    expect(status.error).toBeUndefined();
    expect(status.state).toBe("done");
    expect(status.commit).toBe(head);
    expect((await readFile(join(majhiHome, "bin", "majhi-host"), "utf8")).trim()).toBe("helper");
  });

  it("matches the shared CLI tool table", () => {
    const dump = JSON.parse(execFileSync(BINARY, ["--cli-tools"]).toString()) as Record<string, unknown>;
    const folders = dump._folders;
    delete dump._folders;
    expect(folders).toEqual(cliProfileFolders("/p"));
    const expected: Record<string, unknown> = {};
    for (const [id, tool] of Object.entries(CLI_TOOLS) as [string, CliToolDef][]) {
      expected[id] = {
        name: tool.name,
        binary: tool.binary,
        login: tool.login,
        check: tool.check,
        whoami: tool.whoami ?? null,
        identityFromCheck: tool.identityFromCheck ?? false,
        logout: tool.logout,
        enter: tool.enter,
        loginEnv: cliLoginEnv(tool, "/p"),
      };
    }
    expect(dump).toEqual(expected);
  });

  it("ends after `restart`, answering first", async () => {
    expect((await call("restart", {})).result).toEqual({ accepted: true });
    await waitFor(async () => helperOutput.includes("exit 0"));
    expect(await helperExit).toBe(0);
  });

  it("exercised every method of the protocol", () => {
    expect([...called].sort()).toEqual(Object.keys(HostResultSchemas).sort());
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // Not there yet.
    }
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}
